<script setup lang="ts">
import { computed } from "vue";
import { at } from "../overlay/style";
import cabin from "./art/cabin.svg";
import foundry from "./art/foundry.svg";
import type { Biome, Site } from "./layout";

const props = defineProps<{ site: Site; biome: Biome; selected: boolean; compact: boolean; parentTitle?: string }>();
const emit = defineEmits<{ select: [id: string] }>();
const phases = {
  active: { name: "В работе", mark: "•" },
  needs_input: { name: "Нужен ответ", mark: "?" },
  blocked: { name: "Заблокировано", mark: "−" },
  ready: { name: "На приёмке", mark: "✓" },
};
const phase = computed(() => phases[props.site.task.status]);
const parentLabel = computed(() => props.parentTitle && `Родитель · ${props.parentTitle}`);
const impact = computed(() => props.site.dependents.length ? `Блокирует ${props.site.dependents.length}` : "");
const prs = computed(() => {
  const hosts = { github: new Set<string>(), forgejo: new Set<string>() };
  for (const pr of props.site.task.pull_requests) hosts[pr.provider].add(pr.url);
  const counts = [];
  if (hosts.github.size) counts.push(`GitHub ${hosts.github.size}`);
  if (hosts.forgejo.size) counts.push(`Forgejo ${hosts.forgejo.size}`);
  return counts.length ? `PR · ${counts.join(" · ")}` : "";
});
const description = computed(() => [
  props.site.task.title, props.site.task.project, phase.value.name, parentLabel.value,
  props.site.children ? `Принято прямых подзадач ${props.site.accepted} из ${props.site.children}` : "",
  impact.value, prs.value,
].filter(Boolean).join(" · "));
</script>

<template>
  <button
    type="button" class="site" :class="{ compact }" :style="at(site.x, site.y)"
    :data-status="site.task.status" :data-task-id="site.task.id" :aria-pressed="selected"
    :aria-label="description" :title="description"
    @click="event => { if (event.detail === 0) emit('select', site.task.id); }"
  >
    <span class="building">
      <img :src="biome === 'forest' ? cabin : foundry" alt="" draggable="false">
      <span class="marker" aria-hidden="true"><b>{{ phase.mark }}</b></span>
    </span>
    <span class="plate">
      <strong>{{ site.task.title }}</strong>
      <span class="phase">{{ phase.name }}</span>
      <span v-if="parentLabel" class="parent">{{ parentLabel }}</span>
      <span v-if="site.children || impact" class="counts">
        <span v-if="site.children">Подзадачи {{ site.accepted }}/{{ site.children }}</span>
        <span v-if="impact">{{ impact }}</span>
      </span>
      <span v-if="prs" class="counts">{{ prs }}</span>
    </span>
  </button>
</template>

<style scoped>
.site {
  --art-height: calc(52px * var(--zoom));
  --screen-x: calc(var(--tx) + var(--x) * var(--zoom) * 1px);
  --tint: #d1e9ca;
  --sign: #245646;
  position: absolute;
  left: var(--screen-x);
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px);
  transform: translate(-50%, calc(0px - var(--art-height)));
  display: flex; flex-direction: column; align-items: center;
  width: max-content; max-width: clamp(102px, calc(182px * var(--zoom)), 218px);
  padding: 0; border: 0; background: transparent;
  font: 12px/1.25 var(--sans, system-ui, sans-serif); color: #fff9e6; cursor: pointer;
}
.site[data-status="needs_input"] { --sign: #7b491d; --tint: #ffe0a1; }
.site[data-status="blocked"] { --sign: #863d37; --tint: #ffd0b9; }
.site[data-status="ready"] { --sign: #304f63; --tint: #ceeafa; }
.building {
  position: relative; display: grid; place-items: end center;
  width: calc(76px * var(--zoom)); height: var(--art-height);
}
.building img { display: block; width: 100%; height: 100%; object-fit: contain; object-position: bottom; }
.site.relative .building { border-radius: 50%; outline: 2px dashed #fff0bf; background: #304238aa; }
.marker {
  position: absolute; top: 1%; right: 1%; display: grid; place-items: center;
  width: 17px; height: 17px; border: 1.5px solid var(--tint); border-radius: 50%;
  background: var(--sign); color: #fff9e9; font: bold 13px/1 system-ui, sans-serif;
  box-shadow: 0 1px 3px #30291d80;
}
.compact .marker {
  width: clamp(5px, calc(22px * var(--zoom)), 17px); height: clamp(5px, calc(22px * var(--zoom)), 17px);
  border-width: 1px; font-size: clamp(5px, calc(17px * var(--zoom)), 13px);
}
[data-status="needs_input"] .marker { border-radius: 3px; transform: rotate(45deg); }
[data-status="needs_input"] .marker b { transform: rotate(-45deg); }
[data-status="blocked"] .marker { border-radius: 0; clip-path: polygon(28% 0,72% 0,100% 28%,100% 72%,72% 100%,28% 100%,0 72%,0 28%); }
[data-status="ready"] .marker { border-radius: 3px; }
.plate {
  display: grid; justify-items: center; gap: 1px; max-width: 100%; padding: 4px 8px;
  transform: translateX(clamp(calc(50% - var(--screen-x) + 3px), 0px, calc(100cqw - var(--screen-x) - 50% - 3px)));
  border: 1px solid #f7e9ba9c; border-radius: 4px;
  background: #27382ff5; box-shadow: 0 1px 3px #30291d54;
}
[data-status="needs_input"] .plate { background: #563b25f5; border-color: #f0c578; }
[data-status="blocked"] .plate { background: #513530f5; }
[data-status="ready"] .plate { background: #2c4049f5; }
.plate strong {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
  max-width: 100%; overflow: hidden; overflow-wrap: anywhere; font-weight: 650;
}
.phase { color: var(--tint); font-size: 11px; }
.parent { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #efe9cf; font-size: 10.5px; }
.counts { display: flex; flex-wrap: wrap; justify-content: center; gap: 0 6px; color: #efe9cf; font-size: 10.5px; }
.counts > span { white-space: nowrap; }
.site.above:is(:focus-visible, [aria-pressed="true"]) { flex-direction: column-reverse; transform: translate(-50%, -100%); }
.outside .plate, .compact:not([aria-pressed="true"], :hover, :focus-visible) .plate { display: none; }
.site:hover, .site:focus-visible { z-index: 2; }
.site[aria-pressed="true"] { z-index: 3; }
.site[aria-pressed="true"] .plate, .site:focus-visible .plate { outline: 2px solid #fffae0; outline-offset: 1px; }
.site[aria-pressed="true"] .plate strong { -webkit-line-clamp: 3; }
@media (pointer: coarse) {
  .site { min-width: min(44px, calc(160px * var(--zoom))); min-height: min(44px, calc(130px * var(--zoom))); }
}
</style>
