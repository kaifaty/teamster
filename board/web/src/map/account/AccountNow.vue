<script setup lang="ts">
// «Сейчас» of a subscription: its state in words with why and what follows, and the sign-in the board runs for it —
// its steps, the page to open and the code to enter (Codex) or to paste back (Claude), the sign-in tool's own lines,
// and how it ended. «Войти заново» is the main order while nothing works without a sign-in.
import { computed, nextTick, ref, watch } from "vue";
import type { AccountRow } from "../../lib/accounts";
import type { Login } from "../../types";
import { codeLeft, loginCommand, loginLine, loginLive, loginSteps, type Family, type NowView } from "./account";

const props = defineProps<{
  family: Family;
  name: string;
  row: AccountRow | null;
  nowView: NowView | null;
  /** The latest sign-in to show, going or finished; null when there is none or it was put away. */
  login: Login | null;
  /** «Войти заново» was pressed and the server has not answered yet. */
  starting: boolean;
  loginError: string | null;
  /** Why sending the code or cancelling did not work. */
  actionError: string | null;
  readOnly?: boolean;
  /** Sends the code a Claude page shows to the sign-in tool; false when the server refused it. */
  send: (text: string) => Promise<boolean>;
  /** Another screen stands over this one: it keeps the focus. */
  covered?: boolean;
  now: number;
}>();
const emit = defineEmits<{ signIn: []; cancel: []; dismiss: [] }>();

const live = computed(() => loginLive(props.login));
const finished = computed(() => !!props.login && !live.value);
const failed = computed(() => props.login?.stage === "failed" || props.login?.stage === "cancelled");
const steps = computed(() => (props.login ? loginSteps(props.login) : []));
const line = computed(() => (props.login ? loginLine(props.login) : null));
const left = computed(() => (props.login ? codeLeft(props.login, props.now) : null));
const command = computed(() => loginCommand(props.family, props.name));
const waiting = computed(() => props.login?.stage === "waiting");

// The one-time code to the clipboard.
const copied = ref(false);
async function copyCode() {
  const code = props.login?.code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    copied.value = true;
    setTimeout(() => (copied.value = false), 2000);
  } catch {
    copied.value = false;
  }
}

// The code a Claude sign-in page shows, back to the sign-in tool; the field takes the focus when the tool asks for it.
// A code the server refused stays in the field.
const text = ref("");
const sending = ref(false);
const field = ref<HTMLInputElement | null>(null);
async function submit() {
  const value = text.value.trim();
  if (!value || sending.value) return;
  sending.value = true;
  if (await props.send(value)) text.value = "";
  sending.value = false;
}
watch(
  () => props.login?.prompt,
  async (prompt) => {
    if (!prompt || props.covered) return;
    await nextTick();
    field.value?.focus();
  },
);

// The buttons a sign-in replaces take the focus with them: it goes to the sign-in's first control instead, or to the
// deck, rather than to the page behind the screen.
const panel = ref<HTMLElement | null>(null);
const deck = ref<HTMLElement | null>(null);
watch(
  () => [props.login?.id, props.login?.stage] as const,
  async () => {
    await nextTick();
    const active = document.activeElement;
    if (props.covered || (active && active !== document.body && active.isConnected)) return;
    const target = panel.value?.querySelector<HTMLElement>("a[href], input, button:not([disabled])") ?? panel.value ?? deck.value;
    target?.focus();
  },
);
</script>

<template>
  <section ref="deck" class="deck now" :class="nowView && `tone-${nowView.tone}-deck`" aria-labelledby="account-now" tabindex="-1">
    <div class="deck-head">
      <span class="sigil" aria-hidden="true">◉</span>
      <h3 id="account-now">Сейчас</h3>
    </div>

    <div v-if="nowView" class="state">
      <p class="lead" :class="`tone-${nowView.tone}`">{{ nowView.lead }}</p>
      <!-- While a sign-in goes, its own steps say what follows. -->
      <template v-if="!live">
        <p v-for="detail in nowView.details" :key="detail" class="detail">{{ detail }}</p>
      </template>
      <div v-if="!readOnly && nowView.relogin && !live" class="act">
        <button type="button" class="key main big" :disabled="starting" @click="emit('signIn')">
          {{ starting ? "Запускаю вход…" : "Войти заново" }}
        </button>
        <span class="dim">или в терминале: <code class="mono">{{ command }}</code></span>
      </div>
    </div>

    <p v-if="loginError" class="error" role="alert">
      Не удалось начать вход: {{ loginError }}<template v-if="row">. Можно войти в терминале: <code class="mono">{{ command }}</code></template>
    </p>

    <div v-if="login" ref="panel" class="login well" :class="{ live }" aria-live="polite" tabindex="-1">
      <ol class="steps" aria-label="Шаги входа">
        <li v-for="step in steps" :key="step.id" :class="step.state">
          <span class="dot" aria-hidden="true">{{ step.state === "done" ? "✓" : step.state === "failed" ? "✕" : "" }}</span>
          {{ step.label }}
        </li>
      </ol>
      <p v-if="line" class="line" :class="`tone-${line.tone}`">{{ line.text }}</p>

      <!-- Codex: the page and the one-time code. -->
      <ol v-if="!readOnly && family === 'codex' && live && (login.url || login.code)" class="todo">
        <li>
          <span class="n" aria-hidden="true">1</span>
          <span>Открой страницу входа и войди в аккаунт ChatGPT этой подписки<template v-if="row?.email"> ({{ row.email }})</template>.</span>
          <a v-if="login.url" class="key main" :href="login.url" target="_blank" rel="noopener noreferrer">Открыть страницу входа ↗</a>
        </li>
        <li v-if="login.code">
          <span class="n" aria-hidden="true">2</span>
          <span>Введи на ней код:</span>
          <code class="code mono" :class="{ expired: left?.expired }">{{ login.code }}</code>
          <button type="button" class="key" @click="copyCode">{{ copied ? "Скопировано" : "Скопировать" }}</button>
          <span v-if="left" class="dim" :class="{ 'tone-bad': left.expired }">{{ left.text }}</span>
        </li>
      </ol>

      <!-- Claude: the page opens by itself; its code, if it shows one, comes back here. -->
      <div v-if="!readOnly && family === 'claude' && live && waiting" class="todo claude">
        <p>
          Браузер открывает страницу входа Claude. Войди в аккаунт этой подписки и разреши доступ.
          <a v-if="login.url" class="key" :href="login.url" target="_blank" rel="noopener noreferrer">Открыть страницу входа ↗</a>
        </p>
        <form class="code-form" :class="{ asked: login.prompt }" @submit.prevent="submit">
          <label :for="`code-${login.id}`">{{ login.prompt ? "Вставь код со страницы входа:" : "Если страница показала код, вставь его сюда:" }}</label>
          <input
            :id="`code-${login.id}`"
            ref="field"
            v-model="text"
            class="field mono"
            maxlength="512"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="submit" class="key" :class="{ main: login.prompt }" :disabled="!text.trim() || sending">Отправить</button>
        </form>
      </div>

      <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
      <p v-if="finished && login.message" class="message">{{ login.message }}</p>
      <p v-if="failed && login.error && login.error !== login.message" class="error">{{ login.error }}</p>

      <div class="act">
        <button v-if="!readOnly && live" type="button" class="key danger" @click="emit('cancel')">Отменить вход</button>
        <button v-if="!readOnly && failed" type="button" class="key main" :disabled="starting" @click="emit('signIn')">Попробовать снова</button>
        <button v-if="finished" type="button" class="key" @click="emit('dismiss')">Скрыть</button>
        <span v-if="failed && row" class="dim">или в терминале: <code class="mono">{{ command }}</code></span>
      </div>

      <!-- A failed sign-in opens the tool's own lines: the reason is usually there. -->
      <details v-if="login.output.length" class="output" :open="login.stage === 'failed'">
        <summary>Что пишет программа входа</summary>
        <pre class="mono">{{ login.output.join("\n") }}</pre>
      </details>
    </div>
  </section>
</template>

<style scoped>
.now:focus,
.login:focus {
  outline: none;
}

.now.tone-bad-deck {
  box-shadow: 0 0 0 1px rgba(255, 141, 122, 0.25);
}

.state {
  display: grid;
  gap: 4px;
  padding: 0 2px;
}

.lead {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 22px;
}

.detail {
  margin: 0;
  color: var(--sh-text);
}

.act {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-top: 6px;
}

.key.big {
  padding: 7px 18px;
  font-size: 14px;
}

code {
  overflow-wrap: anywhere;
  color: var(--sh-text);
}

.error {
  margin: 0;
  color: var(--sh-red);
  overflow-wrap: anywhere;
}

.tone-low {
  color: var(--sh-copper);
}

.tone-sleep {
  color: var(--sh-ice);
}

.tone-wait {
  color: var(--sh-wait);
}

/* The sign-in. */
.login {
  display: grid;
  gap: 10px;
  padding: 12px 14px;
}

.login.live {
  border-color: rgba(243, 198, 78, 0.45);
}

.steps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.steps li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 4px;
  border: 1px solid rgba(214, 170, 96, 0.18);
  border-radius: 999px;
  color: var(--sh-faint);
  font-size: 12px;
}

.steps .dot {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: 1px solid currentColor;
  border-radius: 50%;
  font-size: 10px;
  line-height: 1;
}

.steps .done {
  color: var(--sh-green);
}

.steps .current {
  border-color: rgba(243, 198, 78, 0.6);
  color: var(--sh-wait);
}

.steps .current .dot {
  background: currentColor;
  animation: pulse 1.4s ease-in-out infinite;
}

.steps .failed {
  border-color: rgba(255, 141, 122, 0.5);
  color: var(--sh-red);
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.line {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.todo {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.todo li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.todo .n {
  display: inline-grid;
  flex: none;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 1px solid rgba(243, 198, 78, 0.6);
  border-radius: 50%;
  color: var(--sh-title);
  font-size: 12px;
  font-weight: 700;
}

.todo.claude p {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin: 0;
}

.code {
  padding: 4px 14px;
  border: 1px solid rgba(243, 198, 78, 0.55);
  border-radius: 6px;
  background: rgba(243, 198, 78, 0.08);
  color: var(--sh-title);
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.12em;
  line-height: 30px;
  user-select: all;
}

.code.expired {
  border-color: rgba(255, 141, 122, 0.5);
  color: var(--sh-faint);
  text-decoration: line-through;
}

.code-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.code-form label {
  color: var(--sh-dim);
}

.code-form.asked label {
  color: var(--sh-wait);
  font-weight: 600;
}

.code-form .field {
  flex: 1 1 240px;
  width: auto;
}

.message {
  margin: 0;
  color: var(--sh-dim);
  overflow-wrap: anywhere;
}

.output summary {
  color: var(--sh-dim);
  font-size: 12px;
  cursor: pointer;
}

.output pre {
  max-height: 220px;
  margin: 6px 0 0;
  padding: 8px 10px;
  overflow: auto;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.55);
  color: #cfc6b2;
  font-size: 11.5px;
  line-height: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (prefers-reduced-motion: reduce) {
  .steps .current .dot {
    animation: none;
  }
}
</style>
