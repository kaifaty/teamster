<script setup lang="ts">
// The fleet's map: a Pixi scene of the galaxy and its star systems, with HTML labels over it, the toolbar, the control
// panel at the bottom (./console) and the panels. The composables in ./use hold its parts; the builders in ./overlay make
// its labels' texts, and the components there draw them.
import { computed, ref } from "vue";
import type { Board } from "../store/board";
import AccountView from "./account/AccountView.vue";
import frameLight from "./art/frame-light.png";
import MapConsole from "./console/MapConsole.vue";
import DaySummary from "./DaySummary.vue";
import FleetPanel from "./FleetPanel.vue";
import MapToolbar from "./MapToolbar.vue";
import GalaxyLabels from "./overlay/GalaxyLabels.vue";
import SystemLabels from "./overlay/SystemLabels.vue";
import ShipView from "./ship/ShipView.vue";
import StationView from "./station/StationView.vue";
import { useArrivalChime } from "./use/useArrivalChime";
import { useFleetScene } from "./use/useFleetScene";
import { useGalaxyModel } from "./use/useGalaxyModel";
import { useMapPanels } from "./use/useMapPanels";
import { useMapSources } from "./use/useMapSources";
import { useOverlayLabels } from "./use/useOverlayLabels";
import { useStageInsets } from "./use/useStageInsets";
import { useStarLabels } from "./use/useStarLabels";
import { useSystemFleet } from "./use/useSystemFleet";

/** `machine`: the machine whose card is open over the map, or null. */
const props = defineProps<{ board: Board; active: boolean; machine?: string | null }>();
/**
 * `machine`: a machine was clicked in the control panel, with the button to give the focus back to; `panel`: the map
 * opened a ship's bridge or the science station's screen, which replace the machine's card.
 */
const emit = defineEmits<{ board: []; machine: [id: string, opener: HTMLElement | null]; panel: [] }>();

const host = ref<HTMLElement | null>(null);
const overlay = ref<HTMLElement | null>(null);
const fleetPanel = ref<InstanceType<typeof FleetPanel> | null>(null);
const mapConsole = ref<InstanceType<typeof MapConsole> | null>(null);
const summaryButton = computed(() => mapConsole.value?.summaryButton ?? null);

// The order matters: each part reads the ones made before it, and the scene comes last, after everything it draws.
const sources = useMapSources(props);
const { now, demo, sourceKind, source, loaded, tasks, emblemOf, events, eventsError, loadResearch } = sources;

const model = useGalaxyModel(props, sources);
const { starList, systemNames, pickerGroups, station, tankList, machinesData } = model;

const panels = useMapPanels({
  props,
  sources,
  model,
  host,
  fleetPanel,
  summaryButton,
  onMachine: (id, opener) => emit("machine", id, opener),
  onPanel: () => emit("panel"),
});
const { repo, repoModel, selected, shipOpen, hovered, selectedTask, researchOpen, open, openResearch, closeResearch, close, openShip, showOnMap } = panels;
const { account, openAccount, closeAccount } = panels;
const { openMachine, flying, enter, leave, goTo, openTask, summaryOpen, closeSummary } = panels;
const { narrow, logOpen, fleetVisible, toggleFleet, showStation } = panels;

const { sound } = useArrivalChime(sources);

const labels = useOverlayLabels(sources, model);
const { starLabels, constellationLabels } = labels;

const { entries, groups, plates, hidden } = useSystemFleet(sources, model, panels);

const stars = useStarLabels(overlay, repo, model, labels);
const stage = useStageInsets(host, model, panels, stars.scheduleLabels);
const { failure, retry } = useFleetScene({ props, host, overlay, sources, model, panels, entries, stars, stage });
</script>

<template>
  <section class="map" aria-label="Карта задач">
    <MapToolbar
      v-model:repoModel="repoModel"
      :repo="repo"
      :emblem-of="emblemOf"
      :star-list="starList"
      :picker-groups="pickerGroups"
      :fleet-visible="fleetVisible"
      :entries="entries"
      @leave="leave"
      @toggle-fleet="toggleFleet"
    />

    <div v-if="failure" class="fallback" role="alert">
      <p v-if="failure === 'webgl'">Карта не смогла запустить графику в этом браузере. Задачи видны на доске.</p>
      <p v-else>Видеокарта сбросила карту. Можно попробовать ещё раз или перейти на доску.</p>
      <p>
        <a href="#" @click.prevent="emit('board')">Открыть доску</a>
        <template v-if="failure === 'lost'"> · <a href="#" @click.prevent="retry">Повторить</a></template>
      </p>
    </div>

    <div v-show="!failure" ref="host" class="stage">
      <div ref="overlay" class="overlay" :class="{ flying }" :style="{ '--frame': `url(${frameLight})` }">
        <GalaxyLabels v-if="!repo" :star-labels="starLabels" :constellation-labels="constellationLabels" @enter="enter" />
        <SystemLabels v-else :plates="plates" @show-station="showStation" />
      </div>
      <FleetPanel
        v-if="fleetVisible"
        ref="fleetPanel"
        :groups="groups"
        :total="entries.length"
        :hidden="hidden"
        :selected="selected"
        :hovered="hovered"
        :frame="frameLight"
        @pick="open"
        @hover="hovered = $event"
        @close="toggleFleet"
      />
      <MapConsole
        ref="mapConsole"
        v-model:logOpen="logOpen"
        v-model:summaryOpen="summaryOpen"
        v-model:sound="sound"
        v-model:sourceKind="sourceKind"
        :frame="frameLight"
        :now="now"
        :tanks="tankList"
        :stars="starList"
        :machines="machinesData"
        :machine="machine ?? null"
        :account="account"
        :station="station"
        :research-open="researchOpen"
        :log-events="events"
        :events-error="eventsError"
        :repo="repo"
        :system-names="systemNames"
        :emblem-of="emblemOf"
        :narrow="narrow"
        :tasks="tasks"
        :demo="demo"
        :host="source"
        @go="goTo"
        @task="openTask"
        @open-account="openAccount"
        @machine="openMachine"
        @open-research="openResearch"
      />
      <p v-if="!loaded" class="status">Жду первый снимок доски…</p>
      <p v-else-if="!starList.length" class="status">Пока ни одной задачи.</p>
      <p v-else-if="repo && !entries.length" class="status">
        В этом репозитории сейчас нет задач: все закрыты.
      </p>
    </div>

    <StationView
      v-if="researchOpen && active && station"
      :research="station"
      :now="now"
      :frame="frameLight"
      :covered="shipOpen || !!machine"
      :source="source.source"
      :refresh="loadResearch"
      :tasks="source.state.value.tasks"
      :launches="source.state.value.launches"
      @close="closeResearch"
      @open="open"
      @ship="openShip"
    />
    <AccountView
      v-if="account && active"
      :key="account"
      :account-key="account"
      :covered="shipOpen || !!machine"
      :accounts="source.state.value.accounts"
      :logins="source.state.value.logins"
      :tasks="source.state.value.tasks"
      :source="source.source"
      :now="now"
      :frame="frameLight"
      @close="closeAccount"
      @open="open"
    />
    <ShipView
      v-if="shipOpen && selected && active"
      :slug="selected"
      :task="selectedTask"
      :source="source.source"
      :now="now"
      :frame="frameLight"
      :emblem="emblemOf(selectedTask?.repo ?? null)"
      @close="close"
      @show="showOnMap"
      @task="board.put"
    />
    <DaySummary v-if="summaryOpen && active" :source="source.source" :events="events" :frame="frameLight" @close="closeSummary" />
  </section>
</template>

<style scoped>
.map {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: #05070d;
}

.stage :deep(.map-canvas) {
  position: absolute;
  left: 0;
  top: 0;
  display: block;
  touch-action: none;
  outline: none;
}

.status,
.fallback {
  max-width: min(440px, calc(100% - 32px));
  margin: 0;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  color: var(--muted);
  text-align: center;
  box-shadow: var(--shadow);
}

.status {
  position: absolute;
  left: 50%;
  top: 40%;
  z-index: 2;
  transform: translate(-50%, -50%);
}

.fallback {
  margin: 72px auto 0;
  color: var(--text);
}

.fallback p {
  margin: 4px 0;
}

/* Labels stand on the dark sky in both of the board's themes, so their colours are fixed. */
.overlay {
  --tx: 0px;
  --ty: 0px;
  --zoom: 1;
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
  color: #e8e2d4;
  font-size: 12px;
  line-height: 16px;
}

.overlay.flying {
  visibility: hidden;
}

/* The open system's ships, at the right side of the map under the toolbar and above the control panel. */
.stage > .fleet {
  position: absolute;
  top: var(--below-toolbar, 46px);
  right: 10px;
  z-index: 2;
  width: 300px;
  max-height: calc(100% - var(--below-toolbar, 46px) - var(--console-room, 0px) - 8px);
}

@media (max-width: 760px) {
  /* The list opens over the map, above the control panel's strip. */
  .stage > .fleet {
    left: 4px;
    right: 4px;
    width: auto;
  }
}
</style>
