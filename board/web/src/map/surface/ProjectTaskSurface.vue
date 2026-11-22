<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { ZOOM_NOTCH } from "../navigation";
import { at } from "../overlay/style";
import forest from "./art/forest.webp";
import volcanic from "./art/volcanic.webp";
import { layoutSurface, type Site } from "./layout";
import SurfaceSite from "./SurfaceSite.vue";
import type { SurfaceTask } from "./types";
import { useSurfaceCamera } from "./useSurfaceCamera";

const props = defineProps<{ tasks: readonly SurfaceTask[]; selectedId?: string | null; biomes?: Record<string, string> }>();
const emit = defineEmits<{ select: [id: string] }>();
const field = ref<HTMLElement | null>(null);
const layout = computed(() => layoutSurface(props.tasks, props.biomes));
const picked = ref<string | null>(null);
const selected = computed(() => props.selectedId === undefined ? picked.value : props.selectedId);
const selectedSite = computed(() => selected.value === null ? undefined : layout.value.sites.get(selected.value));
function select(id: string) {
  if (!layout.value.sites.has(id)) return;
  if (compact.value) focusTask(id);
  picked.value = id;
  emit("select", id);
}
const { camera, bounds, compact, focusTask, focusProject, zoomBy, home } = useSurfaceCamera(field, layout, selected, select);
defineExpose({ focusTask, focusProject });

const id = useId();
const regions = computed(() => [...layout.value.regions.values()].sort((a, b) => a.project.localeCompare(b.project, "ru")));
const labels = computed(() => {
  const counts = new Map<string, number>();
  const names = [...regions.value].sort((a, b) => b.sites.length - a.sites.length).map(region => {
    const stems = [...region.project.matchAll(/[-._/ ](?=.)/g)].map(m => region.project.slice(0, m.index));
    for (const stem of [...stems, region.project]) counts.set(stem, (counts.get(stem) ?? 0) + 1);
    return { region, stems };
  });
  return names.map(({ region, stems }) => {
    // Keep the part that distinguishes projects, even when they share several leading words.
    const common = stems.filter(stem => counts.get(stem)! > 1).pop();
    const stem = common ?? stems[0];
    const split = stem === undefined ? 0 : stem.length + 1;
    return { region, prefix: region.project.slice(0, split), suffix: region.project.slice(split), shared: common !== undefined };
  });
});
watch([field, labels, () => camera.value.zoom], ([el]) => {
  if (!el) return;
  const elements = Array.from(el.querySelectorAll<HTMLElement>(".region"));
  const boxes = compact.value ? elements.map(label => label.getBoundingClientRect()) : [];
  const taken: DOMRect[] = [];
  elements.forEach((label, i) => {
    const box = boxes[i];
    const covered = box && taken.some(r => box.left < r.right && box.right > r.left && box.top < r.bottom && box.bottom > r.top);
    label.style.visibility = covered ? "hidden" : "";
    if (box && !covered) taken.push(box);
  });
}, { flush: "post" });
const visibleSites = computed(() => {
  const box = bounds.value;
  const pad = 125 / camera.value.zoom;
  return regions.value.flatMap(region => region.sites.filter(site =>
    site.x >= box.x - pad && site.x <= box.x + box.width + pad &&
    site.y >= box.y - pad && site.y <= box.y + box.height + pad).map(site => ({
      site, biome: region.biome,
      outside: site.x < box.x || site.x > box.x + box.width || site.y < box.y || site.y > box.y + box.height,
      above: site.y + pad > box.y + box.height,
    })));
});
function parentOf(site: Site) {
  return site.task.parent_id === null ? undefined : layout.value.sites.get(site.task.parent_id);
}
function isDirectRelative(site: Site) {
  const current = selectedSite.value?.task;
  return current && (site.task.parent_id === current.id || current.parent_id === site.task.id);
}
const families = computed(() => {
  const paths: string[] = [];
  for (const child of layout.value.sites.values()) {
    const parent = parentOf(child);
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
  const site = selectedSite.value;
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
          <pattern v-for="(region, i) in regions" :id="id + '-land-' + i" :key="region.project"
            patternUnits="userSpaceOnUse" :x="region.bounds.x0" :y="region.bounds.y0"
            :width="Math.min(1344, region.bounds.x1 - region.bounds.x0)" :height="Math.min(960, region.bounds.y1 - region.bounds.y0)"
            viewBox="0 0 1344 960" preserveAspectRatio="xMidYMid slice">
            <image :href="region.biome === 'forest' ? forest : volcanic" width="1344" height="960" />
          </pattern>
          <marker :id="id + '-arrow'" viewBox="0 0 12 12" refX="10" refY="6" markerUnits="userSpaceOnUse" markerWidth="15" markerHeight="15" orient="auto">
            <path d="m1 1 10 5-10 5 2-5Z" fill="#ffdf89" stroke="#433b34" stroke-linejoin="round" />
          </marker>
        </defs>
        <g v-if="layout.coastline" stroke-linejoin="round">
          <path :d="layout.coastline" fill="#e8dfb4" stroke="#a7c9b9" stroke-width="10" vector-effect="non-scaling-stroke" />
          <path :d="layout.coastline" fill="none" stroke="#e2dfb7" stroke-width="5" vector-effect="non-scaling-stroke" />
          <path v-for="(region, i) in regions" :key="region.project" :d="region.outline" :fill="`url(#${id}-land-${i})`"
            stroke="#454b3e" stroke-width="2.8" vector-effect="non-scaling-stroke" />
          <path v-for="region in regions" :key="'border-' + region.project" :d="region.outline" fill="none"
            stroke="#ece0ae" stroke-width="0.9" vector-effect="non-scaling-stroke" />
        </g>
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
        v-for="{ region, prefix, suffix, shared } in labels" :key="region.project" class="region" :class="{ compact }"
        :style="{ ...at(region.label.x, region.label.y), '--label-width': region.labelWidth + 'px' }" :title="region.project"
      >
        <b v-if="compact"><span v-if="prefix && (!shared || region.labelWidth * camera.zoom >= 48)">{{ prefix }}</span><wbr><span>{{ suffix }}</span></b>
        <b v-else>{{ region.project }}</b>
        <small v-if="!compact">{{ region.biome === "forest" ? "Хвойное пограничье" : "Вулканическое плато" }}</small>
      </div>
      <SurfaceSite
        v-for="{ site, biome, outside, above } in visibleSites" :key="site.task.id" :site="site" :biome="biome"
        :selected="site.task.id === selected" :parent-title="parentOf(site)?.task.title" :compact="compact"
        :class="{ outside, above, relative: isDirectRelative(site) }" :tabindex="outside ? -1 : 0" @select="select"
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
  background: #7eaaa4; color: #2e352c; font-family: var(--sans, system-ui, sans-serif);
}
.field {
  position: relative; flex: 1 1 0; overflow: clip;
  background: radial-gradient(ellipse at center, #9dbeb0, #719d9a);
  cursor: grab; touch-action: none; user-select: none; -webkit-user-select: none;
}
.field:focus-visible { outline: 2px solid #283d33; outline-offset: -2px; }
.terrain { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.region {
  position: absolute; left: calc(var(--tx) + var(--x) * var(--zoom) * 1px);
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px); transform: translate(-50%, -50%);
  width: max-content; max-width: clamp(32px, calc(var(--label-width) * var(--zoom)), 340px); text-align: center; pointer-events: none;
  color: #fff8df; text-shadow: 0 1px 3px #213b2b, 0 0 7px #253a29, 0 0 13px #35422e;
}
.region b { display: block; overflow-wrap: anywhere; font: 600 27px/1.1 "Iowan Old Style", Georgia, serif; }
.region.compact b { font-size: clamp(10px, calc(52px * var(--zoom)), 21px); }
.region.compact b span { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: top; }
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
