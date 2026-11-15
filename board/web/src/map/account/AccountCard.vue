<script setup lang="ts">
// A subscription's card: what it is (family, plan, the account it signed in to), what it holds (credits and free resets
// for Codex, its share of the pool for Claude), whether it is the orchestrator's reserve, and its last sign-in.
import type { CardRow } from "./account";

defineProps<{ rows: CardRow[] }>();
</script>

<template>
  <section class="deck" aria-labelledby="account-card">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">≡</span>
      <h3 id="account-card">Подписка</h3>
    </div>
    <dl class="card">
      <div v-for="row in rows" :key="row.label" class="row" :title="row.title">
        <dt>{{ row.label }}</dt>
        <dd :class="row.tone ? `tone-${row.tone}` : null">{{ row.value }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.card {
  display: grid;
  gap: 0;
  margin: 0;
}

.row {
  display: grid;
  grid-template-columns: minmax(110px, 40%) minmax(0, 1fr);
  gap: 10px;
  padding: 5px 2px;
  border-bottom: 1px solid rgba(214, 170, 96, 0.1);
}

.row:last-child {
  border-bottom: none;
}

dt {
  color: var(--sh-dim);
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}

.tone-wait {
  color: var(--sh-wait);
}

.tone-bad {
  color: var(--sh-red);
}

.tone-sleep {
  color: var(--sh-ice);
}

.tone-dim {
  color: var(--sh-dim);
}
</style>
