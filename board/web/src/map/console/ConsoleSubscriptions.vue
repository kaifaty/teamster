<script setup lang="ts">
// The subscriptions block: every subscription as a row with its small portrait, a bar of the week left, its figure and its
// reset; the duty's row stands out. A click opens the subscription's screen.
import fuelCell from "../art/fuel-cell.png";
import type { SubscriptionRow } from "./texts";

defineProps<{
  rows: readonly SubscriptionRow[];
  /** Each subscription's portrait, by its key. */
  portraits: ReadonlyMap<string, string>;
  /** The subscription whose screen is open, or null. */
  open: string | null;
}>();
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
          <img v-if="portraits.get(row.key)" class="s-portrait" :src="portraits.get(row.key)" alt="" />
          <span class="s-line">
            <span class="c-name"><span class="glyph" :class="row.executor" aria-hidden="true">{{ row.executor === "codex" ? "◆" : "✳" }}</span>{{ row.name }}</span>
            <span v-if="row.tone !== 'off'" class="s-left num">{{ row.left }}</span>
          </span>
          <span class="s-line">
            <!-- A subscription that gives nothing tells why where its empty bar would stand, and its name keeps its room. -->
            <span v-if="row.tone === 'off'" class="s-why c-text">{{ row.left }}</span>
            <span v-else class="s-bar" aria-hidden="true"><span :style="{ width: `${row.bar}%` }"></span></span>
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
/* A row: the portrait on the left, over both lines; the name and the share, then the bar and the reset. */
.s-row {
  --fuel: #9aa3b0;
  grid-template-columns: 20px minmax(0, 1fr);
  column-gap: 6px;
  align-items: center;
  height: 24px;
  padding-block: 0;
}

.s-row > .s-line {
  grid-column: 2;
}

.s-portrait {
  grid-row: 1 / span 2;
  grid-column: 1;
  width: 20px;
  height: 20px;
  border: 1px solid rgba(240, 165, 70, 0.55);
  border-radius: 3px;
  object-fit: cover;
  object-position: 50% 20%;
}

.s-row.off .s-portrait {
  filter: grayscale(1) brightness(0.7);
  border-color: rgba(160, 150, 130, 0.4);
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
  height: 13px;
  line-height: 13px;
}

.s-line + .s-line {
  height: 9px;
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

.s-why {
  flex: 1;
  color: #a89c86;
  font-size: 10.5px;
  line-height: 10px;
}

.s-until {
  flex: none;
  font-size: 10.5px;
  line-height: 10px;
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
