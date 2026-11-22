<script setup lang="ts">
import { computed, ref, useId } from "vue";
import { ZOOM_NOTCH } from "../navigation";
import { at } from "../overlay/style";
import forest from "./art/forest.webp";
import volcanic from "./art/volcanic.webp";
import { BANK_WIDTH, layoutSurface, type Site, type SurfaceLayout } from "./layout";
import SurfaceSite from "./SurfaceSite.vue";
import type { SurfaceTask } from "./types";
import { useSurfaceCamera } from "./useSurfaceCamera";

const props = defineProps<{ tasks: readonly SurfaceTask[]; selectedId?: string | null; biomes?: Record<string, string> }>();
const emit = defineEmits<{ select: [id: string] }>();
const field = ref<HTMLElement | null>(null);
const layout = computed<SurfaceLayout>(previous => layoutSurface(props.tasks, props.biomes, previous));
const picked = ref<string | null>(null);
const selected = computed(() => props.selectedId === undefined ? picked.value : props.selectedId);
function select(id: string) {
  if (!layout.value.sites.has(id)) return;
  picked.value = id;
  emit("select", id);
}
const { camera, bounds, compact, focusTask, focusProject, zoomBy, home } = useSurfaceCamera(field, layout, selected, select);
defineExpose({ focusTask, focusProject });

const id = useId();
const regions = computed(() => [...layout.value.regions.values()]);
const visibleRegions = computed(() => regions.value.filter(region =>
  (region.bank + 1) * BANK_WIDTH >= bounds.value.x && region.bank * BANK_WIDTH <= bounds.value.x + bounds.value.width));
const regionNames = computed(() => visibleRegions.value.flatMap(region => {
  const box = bounds.value;
  const left = Math.max(region.bank * BANK_WIDTH, box.x);
  const right = Math.min((region.bank + 1) * BANK_WIDTH, box.x + box.width);
  const width = (right - left) * camera.value.zoom - 12;
  return width < 110 ? [] : [{ region, style: { ...at((left + right) / 2, 102), maxWidth: width + "px" } }];
}));
const visibleSites = computed(() => {
  const box = bounds.value;
  const pad = 125 / camera.value.zoom;
  return visibleRegions.value.flatMap(region => region.sites.filter(site =>
    site.x >= box.x - pad && site.x <= box.x + box.width + pad &&
    site.y >= box.y - pad && site.y <= box.y + box.height + pad).map(site => ({
      site, biome: region.biome,
      outside: site.x < box.x || site.x > box.x + box.width || site.y < box.y || site.y > box.y + box.height,
      above: site.y + pad > box.y + box.height,
    })));
});
const families = computed(() => {
  const paths: string[] = [];
  for (const child of layout.value.sites.values()) {
    const parent = child.task.parent_id === null ? undefined : layout.value.sites.get(child.task.parent_id);
    if (parent) paths.push(`M${parent.x} ${parent.y - 9} Q${(parent.x + child.x) / 2} ${child.y + 10} ${child.x} ${child.y - 9}`);
  }
  return paths.join(" ");
});

function dependencyPath(from: Site, to: Site) {
  // Land beside the roof, clear of the nameplate. A link up or down the same column goes around both sites.
  const across = Math.abs(to.x - from.x) > 90;
  const exit = across && from.x > to.x ? -1 : 1;
  const entry = across ? -exit : 1;
  const bend = across ? Math.min(110, Math.abs(to.x - from.x) / 3) : 115;
  const x1 = from.x + exit * 34, y1 = from.y - 25;
  const x2 = to.x + entry * 41, y2 = to.y - 25;
  return `M${x1} ${y1} C${x1 + exit * bend} ${y1 - 40} ${x2 + entry * bend} ${y2 - 40} ${x2} ${y2}`;
}
const arrows = computed(() => {
  const sites = layout.value.sites;
  const site = selected.value === null ? undefined : sites.get(selected.value);
  if (!site) return [];
  const paths = [];
  for (const id of new Set(site.task.depends_on)) {
    const prerequisite = sites.get(id);
    if (prerequisite && prerequisite !== site) paths.push(dependencyPath(prerequisite, site));
  }
  for (const id of site.dependents) paths.push(dependencyPath(site, sites.get(id)!));
  return paths;
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
      :style="{ '--tx': camera.tx + 'px', '--ty': camera.ty + 'px', '--zoom': camera.zoom }"
    >
      <svg
        v-if="bounds.width && bounds.height" class="terrain" aria-hidden="true"
        :viewBox="`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`"
      >
        <defs>
          <pattern :id="id + '-forest'" patternUnits="userSpaceOnUse" :width="BANK_WIDTH" height="480">
            <image :href="forest" :width="BANK_WIDTH" height="480" />
          </pattern>
          <pattern :id="id + '-volcanic'" patternUnits="userSpaceOnUse" :width="BANK_WIDTH" height="480">
            <image :href="volcanic" :width="BANK_WIDTH" height="480" />
          </pattern>
          <marker :id="id + '-arrow'" viewBox="0 0 12 12" refX="10" refY="6" markerUnits="userSpaceOnUse" markerWidth="15" markerHeight="15" orient="auto">
            <path d="m1 1 10 5-10 5 2-5Z" fill="#ffdf89" stroke="#433b34" stroke-linejoin="round" />
          </marker>
        </defs>
        <rect v-bind="bounds" :fill="`url(#${id}-forest)`" />
        <template v-for="region in visibleRegions" :key="region.project">
          <rect v-if="region.biome === 'volcanic'" :x="region.bank * BANK_WIDTH" :y="bounds.y" :width="BANK_WIDTH" :height="bounds.height" :fill="`url(#${id}-volcanic)`" />
        </template>
        <g v-if="families" fill="none" stroke-linecap="round">
          <path :d="families" stroke="#665742" stroke-width="5" />
          <path :d="families" stroke="#eeddb6" stroke-width="2.7" stroke-dasharray="4 5" />
        </g>
        <g v-for="path in arrows" :key="path" fill="none">
          <path :d="path" stroke="#423a33" stroke-width="5.5" />
          <path :d="path" stroke="#ffdf89" stroke-width="2.8" :marker-end="`url(#${id}-arrow)`" />
        </g>
      </svg>
      <div
        v-for="{ region, style } in regionNames" :key="region.project" class="region" :class="{ compact }" :style="style"
      >
        <b>{{ region.project }}</b>
        <small v-if="!compact">{{ region.biome === "forest" ? "Хвойное пограничье" : "Вулканическое плато" }}</small>
      </div>
      <SurfaceSite
        v-for="{ site, biome, outside, above } in visibleSites" :key="site.task.id" :site="site" :biome="biome"
        :selected="site.task.id === selected" :compact="compact" :class="{ outside, above }" :tabindex="outside ? -1 : 0" @select="select"
      />
      <p v-if="!layout.sites.size" class="empty" role="status">Нет текущих заданий</p>
    </div>
    <nav v-if="regions.length" class="controls" aria-label="Навигация по карте">
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
  background: #a2ae89; color: #2e352c; font-family: var(--sans, system-ui, sans-serif);
}
.field {
  position: relative; flex: 1 1 0; overflow: clip;
  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
}
.field:focus-visible { outline: 2px solid #283d33; outline-offset: -2px; }
.terrain { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.region {
  position: absolute; left: calc(var(--tx) + var(--x) * var(--zoom) * 1px);
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px); transform: translate(-50%, -50%);
  width: max-content; text-align: center; pointer-events: none;
  color: #fff8df; text-shadow: 0 1px 3px #213b2b, 0 0 7px #253a29, 0 0 13px #35422e;
}
.region b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 27px/1.1 "Iowan Old Style", Georgia, serif; }
.region.compact b { font-size: 20px; }
.region small { font-size: 10px; font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
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
