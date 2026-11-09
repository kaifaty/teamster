<script setup lang="ts">
// What a button did on a board that only reads: it copied the equivalent command for the terminal.
import { nextTick, ref, watch } from "vue";
import type { Copied } from "./console";

const props = defineProps<{ copied: Copied }>();

const field = ref<HTMLTextAreaElement | null>(null);
// Without a clipboard the command stands selected, ready to copy by hand.
watch(
  () => props.copied,
  async (copied) => {
    if (copied.copied) return;
    await nextTick();
    field.value?.focus();
    field.value?.select();
  },
  { immediate: true },
);
</script>

<template>
  <p v-if="copied.copied" class="copied" role="status">Доска только читает ({{ copied.reason }}): команда скопирована — выполни её в терминале</p>
  <template v-else>
    <p class="copied" role="status">Доска только читает ({{ copied.reason }}), а буфер обмена недоступен: скопируй команду и выполни её в терминале</p>
    <textarea ref="field" class="mono manual" rows="2" readonly :value="copied.command" aria-label="Команда для терминала"></textarea>
  </template>
</template>

<style scoped>
.copied {
  margin: 6px 0 0;
  color: #d4cab5;
  font-size: 12px;
}

.manual {
  width: 100%;
  margin-top: 4px;
  font-size: 11.5px;
}
</style>
