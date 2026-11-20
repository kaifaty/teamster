<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { postAction } from "../../lib/actions";
import { shellQuote } from "../../lib/commands";
import type { BoardSource } from "../../lib/source";
import type { Accounts } from "../../types";
import AccountCard from "./AccountCard.vue";

const props = defineProps<{ provider: string; accounts: Accounts | null; source: BoardSource; readOnly: boolean; frame: string }>();
const emit = defineEmits<{ close: [] }>();
const binding = computed(() => props.accounts?.opencode?.find((item) => item.provider === props.provider));
const dialog = ref<HTMLDialogElement | null>(null);
const removing = ref(false);
const error = ref("");

async function detach() {
  if (!binding.value || removing.value || props.readOnly) return;
  removing.value = true;
  error.value = "";
  const result = await postAction("opencode-remove", { provider: binding.value.provider }, { send: props.source.act });
  removing.value = false;
  if (result.ok) emit("close");
  else error.value = result.error;
}

onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog ref="dialog" class="ship-screen binding" :style="{ '--frame': `url(${frame})` }" aria-labelledby="binding-title" @cancel.prevent="emit('close')">
    <header>
      <h2 id="binding-title">{{ binding?.name ?? provider }}</h2>
      <button type="button" class="key" @click="emit('close')">К карте</button>
    </header>
    <template v-if="binding">
      <AccountCard :rows="[
        { label: 'Провайдер', value: binding.provider },
        { label: 'Харнес', value: 'OpenCode' },
        { label: 'Модель', value: binding.model },
      ]" />
      <label for="session-command">Запустить сеанс в терминале на машине Board</label>
      <textarea id="session-command" class="mono" rows="2" readonly :value="`opencode mini --model ${shellQuote(binding.model)}`" @focus="($event.currentTarget as HTMLTextAreaElement).select()"></textarea>
      <button v-if="!readOnly" type="button" class="key" :disabled="removing" title="Снять привязку, сохранив вход в OpenCode" @click="detach">
        {{ removing ? "Снимаю…" : "Снять с карты" }}
      </button>
      <p v-if="error" class="tone-bad" role="alert">{{ error }}</p>
    </template>
    <p v-else>Этой подписки уже нет на карте.</p>
  </dialog>
</template>

<style scoped>
.binding {
  box-sizing: border-box;
  width: min(480px, calc(100% - 24px));
  border: 1px solid var(--sh-line);
  border-radius: 8px;
  background: #10141b;
}
.binding::backdrop { background: rgba(2, 3, 6, 0.65); }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h2 { margin: 0; overflow-wrap: anywhere; color: var(--sh-title); font-size: 18px; }
.deck, label { display: block; margin: 12px 0 6px; }
textarea { margin-bottom: 8px; }
</style>
