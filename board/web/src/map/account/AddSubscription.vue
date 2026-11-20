<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { postAction } from "../../lib/actions";
import type { BoardSource, OpenCodeProviders } from "../../lib/source";
import type { Login } from "../../types";
import type { Tank } from "../fleet";
import "../ship/ship.css";

const props = defineProps<{ source: BoardSource; readOnly: boolean; tanks: Tank[] }>();
const emit = defineEmits<{ close: []; open: [key: string, login?: Login] }>();
const dialog = ref<HTMLDialogElement | null>(null);
const provider = ref("");
const harness = ref<"" | "codex" | "claude" | "opencode">("");
const model = ref("");
const account = ref("");
const providers = ref<OpenCodeProviders["providers"]>([]);
const status = ref<OpenCodeProviders["status"]>("ok");
const loading = ref(false);
const saving = ref(false);
const error = ref("");

async function refresh() {
  if (loading.value || !props.source.fetchOpenCodeProviders) return;
  loading.value = true;
  try {
    const list = await props.source.fetchOpenCodeProviders();
    status.value = list.status;
    if (list.status === "ok") providers.value = list.providers;
  } catch {
    status.value = "error";
  } finally {
    loading.value = false;
  }
}

const native = [
  { id: "openai", name: "OpenAI", harness: "codex" },
  { id: "anthropic", name: "Anthropic", harness: "claude" },
] as const;
const choices = computed(() => [
  ...native.filter((item) => props.tanks.some((row) => row.executor === item.harness)),
  ...providers.value.map((item) => ({ ...item, harness: "opencode" as const })),
]);
const names = computed(() => new Map(choices.value.map((item) => [item.id, item.name])));
const harnesses = computed(() => choices.value.filter((item) => item.id === provider.value));
const labels = { codex: "Codex", claude: "Claude Code", opencode: "OpenCode" };
const models = computed(() => providers.value.find((item) => item.id === provider.value)?.models ?? []);
watch(names, (available) => {
  if (!available.has(provider.value)) provider.value = "";
});
watch(provider, () => {
  harness.value = "";
  model.value = "";
  error.value = "";
});
watch(harnesses, (options) => {
  if (!options.some((item) => item.harness === harness.value)) harness.value = options.length === 1 ? options[0]!.harness : "";
});
watch(models, (list) => {
  if (!list.includes(model.value)) model.value = list.length === 1 ? list[0]! : "";
});
const validName = computed(() => (harness.value === "codex" ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,40}$/ : /^[a-z0-9][a-z0-9-]{0,254}$/).test(account.value));
const canAdd = computed(() => !props.readOnly && !!props.source.fetchOpenCodeProviders && !saving.value && harness.value &&
  (harness.value === "opencode" ? !loading.value && status.value === "ok" && models.value.includes(model.value) : validName.value));

async function add() {
  if (!canAdd.value || !harness.value) return;
  saving.value = true;
  error.value = "";
  const family = harness.value;
  const options = { send: props.source.act };
  const result = family === "opencode"
    ? await postAction("opencode-add", { provider: provider.value, model: model.value }, options)
    : await postAction("account-add", { family, account: account.value }, options);
  saving.value = false;
  if (!result.ok) error.value = result.error;
  else if (family === "opencode") emit("open", `opencode:${provider.value}`);
  else if (result.login) emit("open", `${family}:${account.value}`, result.login);
  else error.value = "Сервер не подтвердил запуск входа.";
}

onMounted(() => {
  dialog.value?.showModal();
  void refresh();
});
</script>

<template>
  <dialog ref="dialog" class="ship-screen add-subscription" aria-labelledby="add-title" @cancel.prevent="emit('close')" @keydown.esc.stop>
    <form @submit.prevent="add">
      <h2 id="add-title">Добавить подписку</h2>
      <label>Провайдер
        <select v-model="provider" class="field" :disabled="saving" autofocus required>
          <option disabled value="">Выбери провайдера</option>
          <option v-for="[id, name] in names" :key="id" :value="id">{{ name }}</option>
        </select>
      </label>
      <label v-if="provider">Харнес
        <select v-model="harness" class="field" :disabled="saving || harnesses.length < 2" required>
          <option disabled value="">Выбери харнес</option>
          <option v-for="item in harnesses" :key="item.harness" :value="item.harness">{{ labels[item.harness] }}</option>
        </select>
      </label>
      <template v-if="harness === 'opencode'">
        <label>Модель
          <select v-model="model" class="field" :disabled="saving || !models.length" required>
            <option disabled value="">{{ models.length ? "Выбери модель" : "Нет доступных моделей" }}</option>
            <option v-for="id in models" :key="id" :value="id">{{ id }}</option>
          </select>
        </label>
      </template>
      <template v-else-if="harness">
        <label>Имя новой подписки
          <input v-model.trim="account" class="field" :disabled="saving" :maxlength="harness === 'codex' ? 41 : 255" placeholder="work" autocapitalize="none" autocomplete="off" spellcheck="false" required />
        </label>
        <p v-if="account && !validName" class="tone-bad">{{ harness === "codex" ? "До 41 символа: латинские буквы, цифры, дефис и подчёркивание. Начни с буквы или цифры." : "Используй строчные латинские буквы, цифры и дефис. Начни с буквы или цифры." }}</p>
      </template>
      <div v-if="source.fetchOpenCodeProviders">
        <p>Для нового подключения в OpenCode запусти <code>opencode auth login</code> в терминале на машине Board, выбери провайдера и пройди авторизацию.</p>
        <p v-if="status === 'unavailable'">OpenCode не установлен или недоступен серверу Board.</p>
        <p v-else-if="status === 'error'" class="tone-bad" role="status">Не удалось прочитать подключения и модели OpenCode.</p>
        <p v-else-if="!loading && !providers.length">В OpenCode пока нет подключённых провайдеров.</p>
        <button type="button" class="key" :disabled="loading || saving" @click="refresh">{{ loading ? "Обновляю…" : "Обновить список" }}</button>
      </div>
      <p v-if="!source.fetchOpenCodeProviders" role="status">В демонстрационном режиме нельзя добавлять подписки.</p>
      <p v-else-if="readOnly" role="status">Доска запущена с --read-only.</p>
      <p v-if="error" class="tone-bad" role="alert">{{ error }}</p>
      <footer>
        <button type="button" class="key" @click="emit('close')">Закрыть</button>
        <button type="submit" class="key main" :disabled="!canAdd">{{ harness === "opencode" ? "Добавить на карту" : "Начать вход" }}</button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.add-subscription { width: min(400px, calc(100% - 24px)); max-height: calc(100dvh - 24px); padding: 20px; border: 1px solid var(--sh-line); border-radius: 8px; background: #0e1015; color-scheme: dark; }
.add-subscription::backdrop { background: rgba(2, 3, 6, 0.6); }
form, label { display: grid; gap: 12px; }
label { gap: 4px; }
h2 { margin: 0; color: var(--sh-title); font-size: 19px; }
p { margin: 0 0 6px; overflow-wrap: anywhere; }
footer { display: flex; justify-content: flex-end; gap: 8px; }
</style>
