<script setup lang="ts">
// The fleet's map: a Pixi scene of the galaxy and its star systems, with HTML labels over it, the toolbar, the dock and
// the panels. The composables in ./use hold its parts; the builders in ./overlay make its labels' texts.
import { ref } from "vue";
import type { Board } from "../store/board";
import TaskPanel from "../components/TaskPanel.vue";
import frameLight from "./art/frame-light.png";
import fuelCell from "./art/fuel-cell.png";
import DaySummary from "./DaySummary.vue";
import FleetPanel from "./FleetPanel.vue";
import ReplayBar from "./ReplayBar.vue";
import ShipLog from "./ShipLog.vue";
import StationView from "./station/StationView.vue";
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
 * `machine`: a machine's reactor was clicked, with the label to give the focus back to; `panel`: the map opened a
 * task's card or the science station's screen, which replace the machine's card.
 */
const emit = defineEmits<{ board: []; machine: [id: string, opener: HTMLElement | null]; panel: [] }>();

const host = ref<HTMLElement | null>(null);
const overlay = ref<HTMLElement | null>(null);
const fleetPanel = ref<InstanceType<typeof FleetPanel> | null>(null);
const summaryButton = ref<HTMLButtonElement | null>(null);

const hideImage = (event: Event) => {
  (event.target as HTMLElement).hidden = true;
};

// The order matters: each part reads the ones made before it, and the scene comes last, after everything it draws.
const sources = useMapSources(props);
const { now, demo, sourceKind, source, loaded, replay, emblemOf, events, eventsError } = sources;

const model = useGalaxyModel(props, sources);
const { starList, systemNames, pickerGroups, station, machineNote } = model;

const panels = useMapPanels({
  props,
  sources,
  model,
  host,
  overlay,
  fleetPanel,
  summaryButton,
  onMachine: (id, opener) => emit("machine", id, opener),
  onPanel: () => emit("panel"),
});
const { repo, repoModel, selected, hovered, selectedTask, researchOpen, open, openResearch, closeResearch, close } = panels;
const { openMachine, flying, enter, leave, logEvents, replayTime, goTo, seekTo, summaryOpen, closeSummary } = panels;
const { compactDock, logOpen, replayVisible, toggleReplay, fleetVisible, toggleFleet, showStation } = panels;

const labels = useOverlayLabels(sources, model);
const { starLabels, constellationLabels, stationLabel, tankLabels, machineLabels, machineNoteStyle } = labels;

const { entries, groups, plates, hidden } = useSystemFleet(sources, model, panels);

const stars = useStarLabels(overlay, repo, model, labels);
const stage = useStageInsets(host, model, panels, stars.scheduleLabels);
const { failure, retry } = useFleetScene({ props, host, overlay, sources, model, panels, entries, stars, stage });
</script>

<template>
  <section class="map" aria-label="Карта флота">
    <div class="toolbar">
      <button v-if="repo" type="button" class="btn" @click="leave">← Галактика</button>
      <label class="picker">
        <img v-if="emblemOf(repo)" :key="emblemOf(repo)!" class="emblem" :src="emblemOf(repo)!" alt="" @error="hideImage" />
        <span>Система</span>
        <select v-model="repoModel" class="btn" :disabled="!starList.length">
          <option value="">вся галактика</option>
          <optgroup v-for="group in pickerGroups.grouped" :key="group.name" :label="group.name">
            <option v-for="star in group.stars" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
          </optgroup>
          <option v-for="star in pickerGroups.rest" :key="star.repo" :value="star.repo">{{ star.repo }} · {{ star.live }}</option>
        </select>
      </label>
      <div v-if="demo" class="seg" role="group" aria-label="Источник карты">
        <button type="button" class="btn" :aria-pressed="sourceKind === 'board'" @click="sourceKind = 'board'">Доска</button>
        <button type="button" class="btn" :aria-pressed="sourceKind === 'scenario'" @click="sourceKind = 'scenario'">Сценарий</button>
      </div>
      <button ref="summaryButton" type="button" class="btn" :aria-expanded="summaryOpen" @click="summaryOpen = true">Сводка дня</button>
      <button
        v-if="repo"
        type="button"
        class="btn"
        :aria-expanded="fleetVisible"
        aria-controls="fleet-panel"
        :title="fleetVisible ? 'Скрыть список кораблей' : 'Показать список кораблей'"
        @click="toggleFleet"
      >
        Корабли · {{ entries.length }}
      </button>
      <span class="legend" aria-hidden="true">
        <span class="codex">◆ Codex</span>
        <span class="claude">✳ Claude</span>
        <template v-if="!repo">
          <span class="key"><i class="badge b-alarm" />тревоги</span>
          <span class="key"><i class="badge b-ready" />ждут тебя</span>
          <span class="key"><i class="badge b-sleep" />спят</span>
        </template>
      </span>
      <span class="hint">{{ repo ? "Колесо назад, щипок или Esc — к галактике" : "Нажми на звезду · колесо или щипок — масштаб · тяни — обзор" }}</span>
    </div>

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
        <template v-if="!repo">
          <button
            v-for="label in starLabels"
            :key="label.star.repo"
            type="button"
            class="star"
            :class="{ quiet: !label.star.live, alarm: label.star.attention }"
            :style="label.style"
            :data-star="label.star.repo"
            :title="label.title"
            :aria-label="label.title"
            @click="enter(label.star.repo)"
          >
            <img v-if="label.emblem && label.star.live" :key="label.emblem" class="emblem" :src="label.emblem" alt="" @error="hideImage" />
            <span class="s-name">{{ label.star.repo }}<span v-if="label.star.live" class="num"> · {{ label.star.live }}</span></span>
            <span v-if="label.star.attention || label.star.ready || label.star.sleeping" class="badges" aria-hidden="true">
              <b v-if="label.star.attention" class="badge b-alarm">{{ label.star.attention }}</b>
              <b v-if="label.star.ready" class="badge b-ready">{{ label.star.ready }}</b>
              <b v-if="label.star.sleeping" class="badge b-sleep">{{ label.star.sleeping }}</b>
            </span>
          </button>
          <button
            v-if="stationLabel"
            type="button"
            class="station"
            :class="{ live: stationLabel.running, waiting: stationLabel.waiting }"
            :style="stationLabel.style"
            :title="stationLabel.title"
            :aria-expanded="researchOpen"
            @click="openResearch"
          >
            <span class="st-name">Научная станция</span>
            <span class="st-notes">{{ stationLabel.note }}</span>
          </button>
          <div
            v-for="label in machineLabels"
            :key="label.machine.id"
            class="machine"
            :class="{ open: machine === label.machine.id }"
            :style="label.style"
            :data-machine="label.machine.id"
          >
            <button
              type="button"
              class="m-label"
              :class="label.machine.status"
              :title="label.title"
              :aria-pressed="machine === label.machine.id"
              @click="openMachine(label.machine.id, $event.currentTarget as HTMLElement)"
            >
              <span class="m-name">{{ label.machine.name }}</span>
              <span v-if="label.showStatus && label.free.length" class="m-free num">
                <span v-for="item in label.free" :key="item.key" class="m-item" :class="item.level"><i class="m-dot" :style="{ background: item.color }" aria-hidden="true" />{{ item.text }}</span>
              </span>
              <span v-else-if="label.showStatus" class="m-status" :class="label.level">{{ label.status }}</span>
            </button>
          </div>
          <p v-if="machineNoteStyle" class="machine-note" :style="machineNoteStyle" :title="machineNote ?? ''">
            Конфиг машин не прочитан: {{ machineNote }}
          </p>
          <span v-for="label in constellationLabels" :key="label.name" class="constellation" :style="label.style" aria-hidden="true">{{ label.name }}</span>
          <div
            v-for="label in tankLabels"
            :key="label.tank.key"
            class="tank"
            :class="[label.tank.executor, { row: label.row, low: label.low, admiral: label.tank.admiral }]"
            :style="label.style"
            :title="label.title"
          >
            <span class="t-name"><span class="glyph" aria-hidden="true">{{ label.tank.executor === "codex" ? "◆" : "✳" }}</span>{{ label.tank.name }}</span>
            <span class="t-info num">
              <span class="t-text">{{ label.info }}</span>
              <img v-for="cell in label.cells" :key="cell" class="cell" :src="fuelCell" alt="" />
              <span v-if="label.cells" class="visually-hidden">, бесплатных сбросов {{ label.cells }}</span>
              <span v-if="label.tank.admiral" class="visually-hidden">, адмирал</span>
            </span>
          </div>
        </template>
        <template v-else>
          <template v-for="plate in plates" :key="plate.place">
            <span class="plate-st" :class="plate.side" :style="plate.style">{{ plate.text.name }}<span> · {{ plate.text.note }}</span></span>
            <button
              v-if="plate.count"
              type="button"
              class="count"
              :class="{ hovered: plate.count.hovered }"
              :style="plate.count.style"
              :title="plate.count.title"
              :aria-label="`${plate.text.name}: ещё ${plate.count.ships}, показать в списке`"
              @click="showStation(plate.place)"
            >
              +{{ plate.count.ships }}
            </button>
          </template>
        </template>
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
      <div class="dock">
        <p v-if="replayTime" class="plate in-dock num" aria-hidden="true">Перемотка · {{ replayTime }}</p>
        <ReplayBar v-show="replayVisible" id="replay-scale" :replay="replay" :frame="frameLight" :now="now" />
        <ShipLog
          v-model:open="logOpen"
          :events="logEvents"
          :error="replay.at === null ? eventsError : replay.error"
          :repo="repo"
          :frame="frameLight"
          :systems="systemNames"
          :emblem-of="emblemOf"
          :at="replay.at"
          :compact="compactDock"
          @go="goTo"
          @seek="seekTo"
        >
          <template #head>
            <button
              type="button"
              class="dock-replay"
              :class="{ on: replay.active }"
              aria-controls="replay-scale"
              :aria-expanded="replayVisible"
              aria-label="Перемотка дня"
              :title="replayVisible ? 'Скрыть перемотку дня' : 'Показать перемотку дня'"
              @click="toggleReplay"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" />
                <path d="M1 6.4l1.5 1.8L4 6.4" />
                <path d="M8 5v3.2l2.2 1.4" />
              </svg>
            </button>
            <!-- The way back to the live map while the scale with its own button is hidden. -->
            <button v-if="replay.active && !replayVisible" type="button" class="dock-live" @click="replay.live()">В эфир</button>
          </template>
        </ShipLog>
      </div>
      <p v-if="replayTime" class="plate on-sky num" role="status">Перемотка · {{ replayTime }}</p>
      <p v-if="!loaded" class="status">Жду первый снимок доски…</p>
      <p v-else-if="!starList.length" class="status">Пока ни одной задачи: галактика пуста.</p>
      <p v-else-if="repo && !entries.length" class="status">
        {{ replay.at === null ? "В этой системе сейчас никого: все задачи закрыты." : "В этот момент в системе никого." }}
      </p>
    </div>

    <StationView
      v-if="researchOpen && active && station"
      :research="station"
      :now="now"
      :frame="frameLight"
      :covered="!!selected || !!machine"
      @close="closeResearch"
      @open="open"
    />
    <TaskPanel
      v-if="selected && active"
      :slug="selected"
      :task="selectedTask"
      :source="source.source"
      :now="now"
      @close="close"
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

.toolbar {
  position: absolute;
  top: 8px;
  left: 10px;
  right: 10px;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  pointer-events: none;
}

.toolbar > * {
  pointer-events: auto;
}

.picker {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 3px 2px 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  font-weight: 600;
  min-width: 0;
}

.picker select {
  max-width: 260px;
  padding: 1px 6px;
  text-overflow: ellipsis;
  font-weight: 400;
}

.seg {
  display: inline-flex;
}

.seg .btn {
  border-radius: 0;
  margin-left: -1px;
}

.seg .btn:first-child {
  border-radius: var(--radius) 0 0 var(--radius);
  margin-left: 0;
}

.seg .btn:last-child {
  border-radius: 0 var(--radius) var(--radius) 0;
}

.legend {
  display: inline-flex;
  gap: 8px;
  padding: 2px 8px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 85%, transparent);
  font-size: 12px;
  font-weight: 650;
}

.legend .codex {
  color: var(--codex);
}

.legend .claude {
  color: var(--claude);
}

.hint {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  color: var(--muted);
  font-size: 11.5px;
}

/* The ship's log and, over it, the replay's scale. */
.dock {
  position: absolute;
  left: 10px;
  bottom: 8px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 4px;
  box-sizing: border-box;
  width: min(540px, calc(100% - 20px));
  max-height: 62%;
}

.dock > :deep(.log) {
  flex: 0 1 auto;
}

.dock > :deep(.replay) {
  flex: none;
}

/* At the head of the log: the button that shows or hides the replay's scale, and the way back to the live map. */
.dock-replay,
.dock-live {
  flex: none;
  align-self: center;
  box-sizing: border-box;
  height: 22px;
  margin: 0;
  border: 1px solid rgba(214, 170, 96, 0.35);
  border-radius: 2px;
  background: rgba(20, 22, 28, 0.9);
  color: #b8ad98;
  cursor: pointer;
}

.dock-replay {
  display: inline-grid;
  place-items: center;
  width: 22px;
  padding: 0;
}

.dock-replay:hover,
.dock-live:hover {
  border-color: rgba(243, 198, 78, 0.8);
}

.dock-replay.on {
  color: #f3c64e;
}

.dock-replay[aria-expanded="true"] {
  border-color: rgba(243, 198, 78, 0.9);
  background: rgba(243, 198, 78, 0.22);
  color: #f3c64e;
}

.dock-live {
  padding: 0 6px;
  border-color: rgba(255, 141, 122, 0.7);
  color: #ffb3a3;
  font: inherit;
  font-size: 11.5px;
}

.dock-replay:focus-visible,
.dock-live:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

/* Over the map while it replays; the sky's own labels stay clear under it. */
.plate {
  margin: 0;
  padding: 3px 12px;
  border: 1px solid rgba(243, 198, 78, 0.6);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.86);
  color: #f3c64e;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: 0.02em;
  pointer-events: none;
  white-space: nowrap;
}

.plate.on-sky {
  position: absolute;
  left: 50%;
  top: 46px;
  z-index: 2;
  transform: translateX(-50%);
}

/* On a phone the toolbar takes the top of the map: the plate stands over the scale instead. */
.plate.in-dock {
  display: none;
  align-self: center;
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

.star,
.station,
.constellation,
.tank,
.machine,
.machine-note,
.plate-st,
.count {
  position: absolute;
  left: calc(var(--tx) + var(--x) * var(--zoom) * 1px);
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px);
  transform: translateX(-50%);
}

/*
 * A star's label: one line, around its star where placeStarLabels finds room (--dx and --dy from the star's centre);
 * hidden until it is placed, and while it waits for the zoom.
 */
.star {
  left: calc(var(--tx) + var(--x) * var(--zoom) * 1px + var(--dx, 0px));
  top: calc(var(--ty) + var(--y) * var(--zoom) * 1px + var(--dy, 0px));
  transform: none;
  visibility: hidden;
  display: flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  max-width: 220px;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  color: inherit;
  font: inherit;
  font-size: 12.5px;
  line-height: 19px;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
}

.star:has(.emblem) {
  padding-left: 2px;
}

.star.alarm {
  border-color: rgba(255, 141, 122, 0.55);
}

.star:hover {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(26, 28, 34, 0.92);
}

.star:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.star.quiet {
  padding: 0 3px;
  border-color: transparent;
  background: none;
  color: #9aa3b4;
  font-size: 11.5px;
  line-height: 15px;
  text-shadow:
    0 0 3px #05070d,
    0 0 2px #05070d;
}

.star .emblem {
  width: 19px;
  height: 19px;
  padding: 0;
}

/* The counts of a star's ships in trouble, waiting for you and asleep, in the colours of their dots. */
.badges {
  display: flex;
  flex: none;
  gap: 3px;
}

.badge {
  box-sizing: border-box;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 11px;
  font-style: normal;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: center;
}

.b-alarm {
  background: #e0533c;
  color: #fff4ef;
}

.b-ready {
  background: #f3c64e;
  color: #1a1408;
}

.b-sleep {
  background: #a9cdf0;
  color: #0b1626;
}

.legend .key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-weight: 500;
}

.legend .key .badge {
  min-width: 9px;
  height: 9px;
  padding: 0;
}

/* A repository's own mark. It stands on dark in both of the board's themes, like the rest of the map. */
.emblem {
  flex: none;
  box-sizing: border-box;
  width: 30px;
  height: 30px;
  padding: 1px;
  border-radius: 3px;
  background: #0b0e15;
  object-fit: contain;
}

.picker .emblem {
  width: 24px;
  height: 24px;
  margin-left: -6px;
}

.s-name {
  max-width: 100%;
  overflow: hidden;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.s-name .num {
  font-weight: 400;
  color: #b8ad98;
}

/* The science station's label: teal, like its glow; a gold note while lessons wait for a decision. */
.station {
  display: flex;
  flex-direction: column;
  align-items: center;
  max-width: 260px;
  padding: 2px 10px;
  border: 1px solid rgba(95, 214, 200, 0.35);
  border-radius: 3px;
  background: rgba(8, 14, 18, 0.78);
  color: #bfeee6;
  font: inherit;
  font-size: 13px;
  line-height: 17px;
  pointer-events: auto;
  cursor: pointer;
}

.station:hover {
  border-color: rgba(95, 214, 200, 0.85);
  background: rgba(14, 26, 30, 0.92);
}

.station:focus-visible {
  outline: 2px solid #5fd6c8;
  outline-offset: 1px;
}

.st-name {
  font-weight: 650;
  white-space: nowrap;
}

.st-notes {
  color: #9cc2bc;
  font-size: 11.5px;
  white-space: nowrap;
}

.station.live .st-notes {
  color: #7ff0df;
}

.station.waiting .st-notes {
  color: #f3c64e;
}

/*
 * A machine's label on the left of its reactor, at the height of its centre. The status takes the board's level
 * colours at their dark values: the sky is dark in both themes. The line about a broken config stands over the column.
 */
.machine,
.machine-note {
  --ok: #5fc48c;
  --warn: #e0b04f;
  --bad: #f07f76;
  --muted: #9aa3b0;
  transform: translateX(-100%);
}

.machine {
  transform: translate(-100%, -50%);
}

.m-label {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  box-sizing: border-box;
  max-width: 180px;
  margin: 0;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  color: inherit;
  font: inherit;
  font-size: 11.5px;
  line-height: 14px;
  text-align: right;
  white-space: nowrap;
  pointer-events: auto;
  cursor: pointer;
}

.m-label:hover {
  border-color: rgba(243, 198, 78, 0.8);
  background: rgba(26, 28, 34, 0.92);
}

.m-label:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

.machine.open .m-label {
  border-color: #ffffff;
  background: rgba(26, 28, 34, 0.92);
}

.m-label.overloaded {
  border-color: rgba(255, 141, 122, 0.55);
}

.m-label.unknown {
  opacity: 0.8;
}

.m-name,
.m-status {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.m-name {
  font-size: 12px;
  font-weight: 650;
  line-height: 15px;
}

.m-status.ok {
  color: var(--ok);
}

.m-status.warn {
  color: var(--warn);
}

.m-status.bad {
  color: var(--bad);
}

.m-status.muted {
  color: var(--muted);
}

/* What is free on the machine, each figure after a dot of its ring's colour; gold or red while its ring is pressed. */
.m-free {
  display: flex;
  gap: 7px;
  max-width: 100%;
  overflow: hidden;
  color: #c9c1b0;
}

.m-item {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
}

.m-item.warn {
  color: var(--warn);
}

.m-item.bad {
  color: var(--bad);
}

.m-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.machine-note {
  max-width: 280px;
  margin: 0;
  overflow: hidden;
  color: var(--bad);
  font-size: 11.5px;
  line-height: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-shadow:
    0 0 3px #05070d,
    0 0 2px #05070d;
  pointer-events: auto;
}

/* A constellation's name over its stars, in the colour of its cloud: quiet, under the stars' labels. */
.constellation {
  transform: translate(-50%, -50%);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.32em;
  line-height: 16px;
  text-transform: uppercase;
  white-space: nowrap;
  opacity: 0.8;
  text-shadow:
    0 0 4px #05070d,
    0 0 2px #05070d;
}

/*
 * A tank's label on the right of its tank, at the height of its centre; under it in a row on a phone. The admiral's is
 * gold, like the badge on its tank; an empty tank's second line is red.
 */
.tank {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  max-width: 150px;
  padding: 1px 7px;
  border: 1px solid rgba(214, 170, 96, 0.28);
  border-radius: 3px;
  background: rgba(8, 11, 18, 0.8);
  font-size: 11.5px;
  line-height: 14px;
  white-space: nowrap;
  transform: translateY(-50%);
  pointer-events: auto;
  cursor: help;
}

.tank.row {
  align-items: center;
  transform: translateX(-50%);
}

.tank.admiral {
  border-color: rgba(243, 198, 78, 0.75);
}

.t-name,
.t-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.t-name {
  max-width: 100%;
  font-size: 12px;
  font-weight: 650;
  line-height: 15px;
}

.tank.admiral .t-name {
  color: #f3c64e;
}

.tank .glyph {
  display: inline-block;
  width: 12px;
}

.tank.codex .glyph {
  color: #7ea6f5;
}

.tank.claude .glyph {
  color: #e59472;
}

.t-info {
  display: flex;
  align-items: center;
  max-width: 100%;
  color: #b8ad98;
}

.tank.low .t-text {
  color: #ff8d7a;
}

/* A free reset: a spare cell of fuel. */
.cell {
  flex: none;
  width: 8px;
  height: 12px;
  margin-left: 3px;
}

.cell + .cell {
  margin-left: 2px;
}

/* A station's name next to it, away from its ships: under it, over it or left of it. */
.plate-st {
  padding: 0 7px;
  border: 1px solid rgba(214, 170, 96, 0.3);
  border-radius: 3px;
  background: rgba(8, 10, 15, 0.8);
  color: #f3c27a;
  font-weight: 650;
  line-height: 18px;
  white-space: nowrap;
}

.plate-st.above {
  transform: translate(-50%, -100%);
}

.plate-st.left {
  transform: translate(-100%, -50%);
}

.plate-st span {
  color: #9b907c;
  font-weight: 400;
}

/* The ships a station has no berth for: the count stands where the next of them would park. */
.count {
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  min-width: 30px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid rgba(243, 198, 78, 0.7);
  border-radius: 11px;
  background: rgba(14, 16, 22, 0.92);
  color: #f3c64e;
  font: inherit;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 20px;
  pointer-events: auto;
  cursor: pointer;
}

.count:hover,
.count.hovered {
  border-color: #f3c64e;
  background: rgba(60, 48, 20, 0.95);
}

.count:focus-visible {
  outline: 2px solid #f3c64e;
  outline-offset: 1px;
}

/* The open system's ships, at the right side of the map under the toolbar. */
.stage > .fleet {
  position: absolute;
  top: var(--below-toolbar, 46px);
  right: 10px;
  z-index: 2;
  width: 300px;
  max-height: calc(100% - var(--below-toolbar, 46px) - 8px);
}

@media (max-width: 760px) {
  .hint {
    display: none;
  }

  .dock {
    left: 4px;
    bottom: 4px;
    width: calc(100% - 8px);
  }

  .plate.on-sky {
    display: none;
  }

  .plate.in-dock {
    display: block;
  }

  .dock-replay,
  .dock-live {
    height: 32px;
  }

  .dock-replay {
    width: 32px;
  }

  .picker select {
    max-width: 52vw;
  }

  /* The list opens over the map, above the dock's line. */
  .stage > .fleet {
    left: 4px;
    right: 4px;
    width: auto;
    max-height: calc(100% - var(--below-toolbar, 46px) - 52px);
  }

  .plate-st {
    padding: 0 4px;
    font-size: 11.5px;
    line-height: 15px;
  }

  .plate-st span {
    display: none;
  }

  .station {
    padding: 1px 6px;
    font-size: 11.5px;
    line-height: 15px;
  }

  .st-notes {
    font-size: 11px;
  }
}
</style>
