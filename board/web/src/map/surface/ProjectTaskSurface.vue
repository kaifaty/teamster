<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Point, Rect } from "../layout";
import { ZOOM_NOTCH } from "../navigation";
import { WHEEL_GAP_MS } from "../scene/input";
import { BUILDING_HEIGHT, layoutSurface, type Site } from "./layout";
import type { SurfaceScene } from "./scene";
import type { SurfaceTask } from "./types";
import { useSurfaceCamera } from "./useSurfaceCamera";

const props = defineProps<{
  tasks: readonly SurfaceTask[]; selectedId: string | null; biomes?: Record<string, string>; operatorSite?: string;
}>();
const emit = defineEmits<{ select: [id: string] }>();
const field = ref<HTMLElement | null>(null);
const layout = computed(() => layoutSurface(props.tasks, props.biomes));
const selected = computed(() => props.selectedId);
const selectedSite = computed(() => selected.value === null ? undefined : layout.value.sites.get(selected.value));
function select(id: string) {
  if (!layout.value.sites.has(id)) return;
  if (compact.value) focusTask(id);
  emit("select", id);
}
let scene: SurfaceScene | undefined;
const hovered = ref<string | null>(null);
function hover(at: Point | null, covered?: Rect) {
  hovered.value = at && scene ? scene.hit(at, covered) : null;
  const el = field.value;
  if (el && el.style.cursor !== "grabbing") el.style.cursor = hovered.value ? "pointer" : "";
}
const { camera, size, compact, focusTask, focusProject, zoomBy, home } = useSurfaceCamera(field, layout, selected, (at, covered) => {
  const id = scene?.hit(at, covered);
  if (id) select(id);
}, hover);
defineExpose({ focusTask, focusProject });

const operatorMarker = computed(() => {
  const site = props.operatorSite && layout.value.sites.get(props.operatorSite);
  if (!site) return null;
  const at = compact.value ? layout.value.regions.get(site.task.project)?.label : site;
  if (!at) return null;
  const { zoom, tx, ty } = camera.value;
  const offset = compact.value ? 20 : BUILDING_HEIGHT * zoom + 4;
  return {
    left: `${tx + at.x * zoom}px`,
    top: `${ty + at.y * zoom - offset}px`,
  };
});

const regions = computed(() => [...layout.value.regions.values()].sort((a, b) => a.project.localeCompare(b.project, "ru")));
const families = computed(() => [...layout.value.sites.values()].some(({ task }) =>
  task.parent_id !== null && layout.value.sites.has(task.parent_id)));
const arrows = computed(() => {
  const sites = layout.value.sites, current = selectedSite.value;
  const links: [Site, Site][] = [];
  if (current) {
    for (const id of new Set(current.task.depends_on)) {
      const from = sites.get(id);
      if (from && from !== current) links.push([from, current]);
    }
    for (const id of current.dependents) links.push([current, sites.get(id)!]);
  }
  return links;
});

const unavailable = ref(false);
let disposed = false, frame = 0;
const detailZoom = ref(camera.value.zoom);
let pinching = false;
function settleZoom() {
  detailZoom.value = camera.value.zoom;
}
function setPinching(active: boolean) {
  if (pinching && !active) settleZoom();
  pinching = active;
}
function touchChanged(event: TouchEvent) {
  setPinching(event.targetTouches.length >= 2);
}
// Keep the prepared mesh strokes and text layout while the camera moves between detail levels.
watch([layout, () => camera.value.zoom, compact], ([next, zoom, isCompact], [previous, , wasCompact], onCleanup) => {
  if (!scene || next !== previous || isCompact !== wasCompact || zoom >= detailZoom.value * 2 || zoom <= detailZoom.value / 2) {
    settleZoom();
  } else if (!pinching && zoom !== detailZoom.value) {
    // Wheel pinches have no end event. A quiet wheel refines the last frame exactly once.
    const timer = window.setTimeout(settleZoom, WHEEL_GAP_MS);
    onCleanup(() => window.clearTimeout(timer));
  }
});
function draw() {
  frame = 0;
  scene?.draw(layout.value, camera.value, size.value, detailZoom.value, compact.value, selected.value, hovered.value, arrows.value);
}
function redraw() {
  if (scene && !frame) frame = requestAnimationFrame(draw);
}
watch([layout, camera, size], () => { hover(null); redraw(); });
watch([selected, hovered, detailZoom, compact], redraw);
watch(size, async () => {
  try {
    const { createSurfaceScene } = await import("./scene");
    for (const backend of ["webgpu", "webgl"] as const) {
      if (disposed) return;
      let ready: SurfaceScene | undefined;
      try {
        ready = await createSurfaceScene(backend, redraw);
        if (disposed) { ready.destroy(); return; }
        const candidate = ready;
        // Check the first frame before exposing the canvas. The device can report errors asynchronously.
        await candidate.present(() => {
          candidate.draw(layout.value, camera.value, size.value, camera.value.zoom, compact.value,
            selected.value, hovered.value, arrows.value);
        });
        if (disposed) { candidate.destroy(); return; }
        scene = candidate;
        field.value!.prepend(candidate.canvas);
        settleZoom();
        redraw();
        return;
      } catch (error) {
        ready?.destroy();
        if (backend === "webgl") throw error;
      }
    }
  } catch (error) {
    if (disposed) return;
    unavailable.value = true;
    console.warn("Could not initialize the territory map renderer", error);
  }
}, { once: true });
onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(frame);
  scene?.destroy();
  scene = undefined;
});
function chooseProject(event: Event) {
  const picker = event.currentTarget as HTMLSelectElement;
  focusProject(picker.value);
  picker.selectedIndex = 0;
}
</script>

<template>
  <section class="surface" aria-label="Карта проектных заданий">
    <div
      ref="field" class="field" role="group" tabindex="0"
      aria-label="Карта местности. Стрелки перемещают карту, плюс и минус меняют масштаб."
      @keydown.home.prevent="home"
      @touchstart.passive="touchChanged" @touchend.passive="touchChanged" @touchcancel.passive="touchChanged"
      @gesturestart="setPinching(true)" @gestureend="setPinching(false)"
    >
      <p v-if="!layout.sites.size" class="empty" role="status">Нет текущих заданий</p>
      <p v-else-if="unavailable" class="empty" role="status">Графическая карта недоступна. Выберите задание в списке.</p>
      <span v-if="operatorMarker && !unavailable" class="operator-marker" :style="operatorMarker" aria-hidden="true">Mini</span>
    </div>
    <nav v-if="regions.length && !unavailable" class="controls" aria-label="Навигация по карте">
      <select aria-label="Перейти к проекту" @change="chooseProject">
        <option value="" disabled selected>К проекту…</option>
        <option v-for="region in regions" :key="region.project" :value="region.project">{{ region.project }} ({{ region.sites.length }})</option>
      </select>
      <div class="zoom">
        <button type="button" aria-label="Уменьшить масштаб" @click="zoomBy(1 / ZOOM_NOTCH)">−</button>
        <button type="button" title="Вернуть начальный вид" aria-label="Вернуть начальный вид" @click="home">{{ Math.round(camera.zoom * 100) }}%</button>
        <button type="button" aria-label="Увеличить масштаб" @click="zoomBy(ZOOM_NOTCH)">+</button>
      </div>
      <div v-if="families || arrows.length" class="legend">
        <span v-if="families"><i class="family-key" />Подзадача</span>
        <span v-if="arrows.length"><i class="arrow-key">→</i>Зависимость</span>
      </div>
    </nav>
  </section>
</template>

<style scoped>
.surface {
  display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: min(320px, 70dvh);
  isolation: isolate; container-type: inline-size; overflow: hidden; color-scheme: light;
  background: #7eaaa4; color: #2e352c; font-family: var(--sans, system-ui, sans-serif);
}
.field {
  position: relative; flex: 1 1 0; overflow: clip;
  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
}
.field:focus-visible { outline: 2px solid #283d33; outline-offset: -2px; }
.field :deep(canvas) { position: absolute; inset: 0; display: block; }
.operator-marker {
  position: absolute; z-index: 1; transform: translate(-50%, -100%); pointer-events: none;
  padding: 2px 7px; border: 1px solid #c9e9df; border-radius: 8px;
  background: #163e37; color: #e1fff3; box-shadow: 0 1px 4px #172a24a0; font: 700 11px/1.2 var(--sans);
}
.empty {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0;
  width: max-content; max-width: 90%; padding: 12px 20px; border: 1px solid #cbbfa7; border-radius: 5px;
  background: #f6f1e3; box-shadow: 0 2px 8px #36433138; font: 600 18px/1.3 Georgia, serif;
}
.controls {
  display: flex; flex-wrap: wrap; align-items: center; gap: 5px 12px; padding: 5px 10px;
  border-top: 1px solid #a99f85; background: #f3eedf; font-size: 12px;
}
.controls select, .controls button {
  min-height: 32px; border: 1px solid #c9c3af; border-radius: 4px; background: #fffcf1; color: #343d32;
  cursor: pointer; font: inherit;
}
.controls select { max-width: min(48%, 24em); padding: 0 6px; text-overflow: ellipsis; }
.zoom { display: flex; gap: 2px; margin-left: auto; order: 1; }
.zoom button { min-width: 33px; font-size: 18px; line-height: 1; }
.zoom button:nth-child(2) { min-width: 47px; font-size: 12px; font-variant-numeric: tabular-nums; }
.legend, .legend span { display: flex; align-items: center; gap: 5px; }
.legend { flex-wrap: wrap; gap: 2px 12px; color: #575748; font-size: 11px; }
.family-key { width: 18px; border-bottom: 3px dashed #897455; }
.arrow-key { color: #685428; font: bold 20px/1 Georgia, serif; }
@container (max-width: 520px) { .legend { order: 2; flex-basis: 100%; } }
@media (pointer: coarse) { .controls select, .zoom button { min-height: 44px; } .zoom button { min-width: 44px; } }
</style>
