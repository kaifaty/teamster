<script setup lang="ts">
// The subscriptions block: every subscription as a row with a bar of the week left, its figure and its reset; the duty's
// row stands out. A click opens the subscription's screen.
import fuelCell from "../art/fuel-cell.png";
import type { SubscriptionRow } from "./texts";

defineProps<{ rows: readonly SubscriptionRow[]; /** The subscription whose screen is open, or null. */ open: string | null }>();
const emit = defineEmits<{ open: [key: string] }>();
</script>

<template>
  <section class="console-block console-subscriptions" aria-labelledby="console-subscriptions-title">
    <h2 id="console-subscriptions-title" class="c-title">Подписки</h2>
    <p v-if="!rows.length" class="c-note">Подписок нет</p>
    <ul v-else class="c-rows">
      <li v-for="row in rows" :key="row.key">
        <button
          type="button"
          class="c-row s-row"
          :class="[row.tone, { duty: row.duty, current: open === row.key }]"
          :title="row.title"
          :aria-label="row.label"
          :data-account="row.key"
          @click="emit('open', row.key)"
        >
          <span class="s-line">
            <span class="c-name"><span class="glyph" :class="row.executor" aria-hidden="true">{{ row.executor === "codex" ? "◆" : "✳" }}</span>{{ row.name }}</span>
            <span class="s-left num">{{ row.left }}</span>
          </span>
          <span class="s-line">
            <span class="s-bar" aria-hidden="true"><span :style="{ width: `${row.bar}%` }"></span></span>
            <span v-if="row.cells" class="s-cells" aria-hidden="true"><img v-for="cell in row.cells" :key="cell" class="cell" :src="fuelCell" alt="" /></span>
            <span v-if="row.until" class="s-until c-muted num">{{ row.until }}</span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped src="./console.css"></style>

<style scoped>
.s-row {
  --fuel: #9aa3b0;
  gap: 0;
}

.s-row.codex {
  --fuel: #7ea6f5;
}

.s-row.claude {
  --fuel: #e59472;
}

.s-row.low {
  --fuel: #f07f76;
}

.s-row.off {
  --fuel: #6f6a60;
  color: #a89c86;
}

/* The duty's row: gold, like the duty's name. */
.s-row.duty {
  border-color: rgba(243, 198, 78, 0.6);
  background: rgba(243, 198, 78, 0.08);
}

.s-row.duty .c-name {
  color: #f3c64e;
}

.s-row.current {
  border-color: #ffffff;
}

.s-line {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.s-line .c-name {
  flex: 1;
}

.glyph {
  display: inline-block;
  width: 13px;
  font-weight: 400;
}

.glyph.codex {
  color: #7ea6f5;
}

.glyph.claude {
  color: #e59472;
}

.s-left {
  flex: none;
  color: #e8e2d4;
}

.s-row.low .s-left {
  color: #ff8d7a;
}

.s-row.off .s-left {
  color: #a89c86;
}

.s-until {
  flex: none;
  font-size: 11px;
  line-height: 12px;
}

.s-bar {
  flex: 1;
  min-width: 24px;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.1);
}

.s-bar span {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: var(--fuel);
  transition: width 0.4s ease;
}

/* A free reset: a spare cell. */
.s-cells {
  display: inline-flex;
  flex: none;
  gap: 2px;
}

.cell {
  width: 6px;
  height: 9px;
}

@media (prefers-reduced-motion: reduce) {
  .s-bar span {
    transition: none;
  }
}
</style>
