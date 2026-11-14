<script setup lang="ts">
// The open tasks whose executor works on this subscription now: a click opens the task's bridge over this screen.
import { formatAge } from "../../lib/format";
import { taskTitle } from "../../lib/labels";
import type { TaskSummary } from "../../types";
import { stateOf } from "../ship/bridge";
import type { Family } from "./account";

defineProps<{ tasks: TaskSummary[]; family: Family; now: number }>();
const emit = defineEmits<{ open: [slug: string] }>();
</script>

<template>
  <section class="deck" aria-labelledby="account-tasks">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">⇢</span>
      <h3 id="account-tasks">Задачи на подписке</h3>
      <span class="aside num">{{ tasks.length || "" }}</span>
    </div>
    <p v-if="!tasks.length" class="empty">Сейчас ни одна задача не работает на этой подписке.</p>
    <ul v-else class="list">
      <li v-for="task in tasks" :key="task.slug">
        <button type="button" class="task" :title="`Открыть задачу ${task.slug}`" @click="emit('open', task.slug)">
          <span class="title">{{ taskTitle(task) }}</span>
          <span class="meta">
            <span class="repo">{{ task.repo }}</span>
            <span class="state" :class="stateOf(task).tone">{{ stateOf(task).text }}</span>
            <span class="age dim num">{{ formatAge(task.updated_at, now) }}</span>
          </span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.list {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 6px 10px;
  border: 1px solid rgba(214, 170, 96, 0.14);
  border-radius: 6px;
  background: rgba(4, 6, 9, 0.7);
  color: var(--sh-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.task:hover {
  border-color: rgba(243, 198, 78, 0.5);
  background: rgba(243, 194, 122, 0.06);
}

.title {
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
}

.repo {
  color: var(--sh-dim);
}

.state.work {
  color: var(--sh-teal);
}

.state.wait {
  color: var(--sh-wait);
}

.state.ready {
  color: var(--sh-green);
}

.state.sleep {
  color: var(--sh-ice);
}

.state.bad {
  color: var(--sh-red);
}

.state.dim {
  color: var(--sh-dim);
}

.age {
  margin-left: auto;
}
</style>
