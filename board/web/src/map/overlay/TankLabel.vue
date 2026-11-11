<script setup lang="ts">
// A tank's label: the account's name, what is left in it, and its free resets as spare cells.
import fuelCell from "../art/fuel-cell.png";
import type { tankLabels } from "./tanks";

defineProps<{ label: ReturnType<typeof tankLabels>[number] }>();
</script>

<template>
  <div
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
      <span v-if="label.tank.admiral" class="visually-hidden">, резерв оркестратора</span>
    </span>
  </div>
</template>

<style scoped src="./overlay.css"></style>

<style scoped>
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
</style>
