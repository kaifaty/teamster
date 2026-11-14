<script setup lang="ts">
// A subscription's own screen. Clicking a fuel tank on the map opens it over the galaxy, like a ship's bridge: a header,
// then «Сейчас» across the screen — the state in words and, when the subscription needs it, the sign-in the board runs —
// and under it its limits and its tasks beside its card. The board server signs in and refreshes the data itself.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { postAction, type AccountBody, type ActionBodies, type ActionRoute } from "../../lib/actions";
import type { BoardSource } from "../../lib/source";
import type { Accounts, Login, TaskSummary } from "../../types";
import nebula from "../art/nebula.jpg";
import "../ship/ship.css";
import {
  FAMILY_NAMES,
  SIGNED_IN,
  accountsContext,
  awaitingData,
  cardOf,
  currentLogin,
  findAccount,
  lastLoginOf,
  latestLogin,
  limitsOf,
  loginLive,
  nowOf,
  planName,
  stateOf,
  tasksOn,
} from "./account";
import AccountCard from "./AccountCard.vue";
import AccountLimits from "./AccountLimits.vue";
import AccountNow from "./AccountNow.vue";
import AccountTasks from "./AccountTasks.vue";

const props = defineProps<{
  /** The subscription's key, `<family>:<name>`, as its tank's. */
  accountKey: string;
  accounts: Accounts | null;
  logins: Readonly<Record<string, Login>>;
  tasks: Readonly<Record<string, TaskSummary>>;
  source: BoardSource;
  now: number;
  frame: string;
  /** A task's bridge or a machine's card stands over this screen: its keys and focus are theirs. */
  covered?: boolean;
}>();
/** `open`: a task on this subscription was picked, its bridge opens over this screen. */
const emit = defineEmits<{ close: []; open: [slug: string] }>();

const family = computed(() => (props.accountKey.startsWith("claude:") ? "claude" : "codex"));
const name = computed(() => props.accountKey.slice(props.accountKey.indexOf(":") + 1));
const body = computed<AccountBody>(() => ({ family: family.value, account: name.value }));

const data = computed(() => props.accounts?.data ?? null);
const row = computed(() => findAccount(data.value, props.accountKey, props.now));
const context = computed(() => accountsContext(data.value));

// The sign-in: the server's latest one for this subscription, or the one its answer just gave until the board knows it.
const started = ref<Login | null>(null);
watch(
  () => started.value && props.logins[started.value.id],
  (known) => {
    if (known) started.value = null;
  },
);
const login = computed(() => {
  const known = latestLogin(props.logins, family.value, name.value);
  const own = started.value?.family === family.value && started.value.account === name.value ? started.value : null;
  const latest = !own ? known : !known || own.started_at >= known.started_at ? own : known;
  return currentLogin(latest, props.now);
});
/** A finished sign-in the person put away: «Сейчас» shows the subscription again. */
const dismissed = ref<string | null>(null);
const shownLogin = computed(() => (login.value && login.value.id !== dismissed.value ? login.value : null));
/** Signed in, but the subscription's data is older than the sign-in: it would still say a sign-in is needed. */
const awaiting = computed(() => awaitingData(login.value, props.accounts?.fetched_at ?? null));

const state = computed(() =>
  awaiting.value ? { text: "вход выполнен", tone: "ok" as const } : row.value ? stateOf(row.value, shownLogin.value, context.value) : null,
);
const nowView = computed(() => (awaiting.value ? SIGNED_IN : row.value ? nowOf(row.value, context.value, props.now) : null));
const limits = computed(() => (row.value ? limitsOf(row.value, context.value, props.now) : []));
const card = computed(() =>
  row.value ? cardOf(row.value, context.value, lastLoginOf(props.accounts?.last_logins, family.value, name.value), props.accounts?.fetched_at ?? null, props.now) : [],
);
const working = computed(() => tasksOn(props.tasks, family.value, name.value));

// Orders: each answers at once; the sign-in's steps then come from the server.
function act<R extends ActionRoute>(route: R, payload: ActionBodies[R]) {
  return postAction(route, payload, { send: props.source.act });
}

const starting = ref(false);
const loginError = ref<string | null>(null);
async function signIn() {
  if (starting.value || loginLive(login.value)) return;
  starting.value = true;
  loginError.value = null;
  dismissed.value = null;
  const result = await act("login", body.value);
  starting.value = false;
  if (!result.ok) loginError.value = result.error;
  else if (result.login) started.value = result.login;
}

/** Why sending the code or cancelling did not work. */
const actionError = ref<string | null>(null);
async function send(text: string): Promise<boolean> {
  const current = login.value;
  if (!current) return false;
  actionError.value = null;
  const result = await act("login/input", { id: current.id, text });
  if (!result.ok) actionError.value = `Код не дошёл: ${result.error}`;
  return result.ok;
}

async function cancel() {
  const current = login.value;
  if (!current) return;
  actionError.value = null;
  const result = await act("login/cancel", { id: current.id });
  if (!result.ok) actionError.value = `Не удалось отменить вход: ${result.error}`;
}

function dismiss() {
  if (login.value && !loginLive(login.value)) dismissed.value = login.value.id;
  loginError.value = null;
  actionError.value = null;
}

// «Обновить»: the answer comes as an accounts message read after the request — for Claude, once the probe has read
// this subscription's limits anew (its `updatedAt` changes), since a periodic read may land first. At most 160 s.
const refreshing = ref<{ after: number; updatedAt: number | null } | null>(null);
const refreshError = ref<string | null>(null);
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  if (refreshing.value) return;
  refreshing.value = { after: Date.now() / 1000, updatedAt: row.value?.updatedAt ?? null };
  refreshError.value = null;
  const result = await act("account-refresh", body.value);
  if (!result.ok) {
    refreshing.value = null;
    refreshError.value = result.error;
    return;
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshing.value = null;
  }, 160_000);
}
watch(
  () => [props.accounts?.fetched_at ?? null, row.value?.updatedAt ?? null, row.value?.needsLogin] as const,
  ([fetchedAt, updatedAt, needsLogin], previous) => {
    const waiting = refreshing.value;
    if (!waiting || fetchedAt === null || fetchedAt < waiting.after) return;
    const done = family.value === "codex" || updatedAt !== waiting.updatedAt || needsLogin !== previous?.[2];
    if (!done) return;
    refreshing.value = null;
    clearTimeout(refreshTimer);
  },
);

const back = ref<HTMLButtonElement | null>(null);
function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.isComposing || props.covered) return;
  event.preventDefault();
  // Escape in a field leaves the field; the next one leaves the screen.
  const field = event.target instanceof HTMLElement && event.target.closest("input, textarea, select");
  if (field) {
    (field as HTMLElement).blur();
    return;
  }
  emit("close");
}
onMounted(() => {
  back.value?.focus();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  clearTimeout(refreshTimer);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <section
    class="ship-screen account-screen"
    role="dialog"
    aria-modal="false"
    aria-labelledby="account-title"
    :style="{ '--frame': `url(${frame})`, '--sky': `url(${nebula})` }"
  >
    <div class="bridge">
      <header class="head">
        <button ref="back" type="button" class="key back" title="Вернуться к карте (Esc)" @click="emit('close')">← К карте</button>
        <div class="who">
          <span class="emblem" :class="family" aria-hidden="true">{{ family === "codex" ? "◆" : "✳" }}</span>
          <div class="names">
            <h2 id="account-title">{{ name }}</h2>
            <div class="sub">
              Подписка {{ FAMILY_NAMES[family] }}<template v-if="row?.plan"> · {{ planName(row.plan) }}</template><template v-if="row?.email"> · {{ row.email }}</template>
            </div>
          </div>
        </div>
        <span v-if="state" class="pill" :class="state.tone">{{ state.text }}</span>
        <span v-if="row?.duty" class="pill wait" title="Новые задачи эту подписку не берут: она в резерве оркестратора">резерв</span>
        <nav class="links" aria-label="Действия">
          <button
            type="button"
            class="key"
            :disabled="!!refreshing"
            :title="family === 'claude' ? 'Отправить короткий запрос и прочитать лимиты заново' : 'Прочитать лимиты подписок заново'"
            @click="refresh"
          >
            {{ refreshing ? "Обновляю…" : "Обновить" }}
          </button>
          <button
            v-if="row && !nowView?.relogin && !loginLive(shownLogin)"
            type="button"
            class="key"
            :disabled="starting"
            title="Войти в аккаунт этой подписки ещё раз, например в другой аккаунт"
            @click="signIn"
          >
            Войти заново
          </button>
        </nav>
      </header>

      <p v-if="refreshError" class="note bad" role="status">Не удалось обновить: {{ refreshError }}</p>
      <p v-if="!accounts?.data" class="note">Доска ещё не прочитала подписки.</p>
      <p v-else-if="!row" class="note">Подписки {{ name }} больше нет в настройках teamster.</p>

      <template v-if="row && nowView">
        <AccountNow
          :family="family"
          :name="name"
          :row="row"
          :now-view="nowView"
          :login="shownLogin"
          :starting="starting"
          :login-error="loginError"
          :action-error="actionError"
          :send="send"
          :covered="covered"
          :now="now"
          @sign-in="signIn"
          @cancel="cancel"
          @dismiss="dismiss"
        />
        <main class="grid">
          <div class="col main-col">
            <AccountLimits :bars="limits" />
            <AccountTasks :tasks="working" :family="family" :now="now" @open="emit('open', $event)" />
          </div>
          <div class="col side">
            <AccountCard :rows="card" />
          </div>
        </main>
      </template>
    </div>
  </section>
</template>

<style scoped>
.account-screen {
  position: absolute;
  inset: 0;
  z-index: 14;
  overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 30%, rgba(5, 7, 13, 0.4), rgba(5, 7, 13, 0.88) 75%),
    var(--sky) center top / cover no-repeat,
    #05070d;
  animation: open 0.32s ease-out;
}

@keyframes open {
  from {
    opacity: 0;
    transform: scale(0.985);
  }
}

.bridge {
  display: grid;
  align-content: start;
  gap: 10px;
  height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 12px max(12px, env(safe-area-inset-right, 0px)) 32px max(12px, env(safe-area-inset-left, 0px));
  scrollbar-width: thin;
  scrollbar-color: rgba(214, 170, 96, 0.35) transparent;
}

.bridge > * {
  width: 100%;
  max-width: 1180px;
  margin: 0 auto;
}

.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
}

.back {
  flex: none;
  color: var(--sh-title);
}

.who {
  display: flex;
  flex: 1 1 280px;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.emblem {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--sh-line);
  border-radius: 50%;
  background: #121a26;
  font-size: 17px;
}

.emblem.codex {
  color: #7ea6f5;
}

.emblem.claude {
  color: #e59472;
}

.names {
  min-width: 0;
}

h2 {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--sh-text);
  font-size: 19px;
  font-weight: 600;
  line-height: 24px;
}

.sub {
  overflow-wrap: anywhere;
  color: var(--sh-dim);
  font-size: 12px;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 12px;
  white-space: nowrap;
}

.pill::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.pill.ok {
  color: var(--sh-green);
}

.pill.low {
  color: var(--sh-copper);
}

.pill.wait {
  color: var(--sh-wait);
}

.pill.sleep {
  color: var(--sh-ice);
}

.pill.bad {
  color: var(--sh-red);
}

.pill.dim {
  color: var(--sh-dim);
}

.links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.note {
  margin: 0;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(7, 9, 14, 0.85);
  color: var(--sh-dim);
}

.note.bad {
  color: var(--sh-red);
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(280px, 360px);
  align-items: start;
  gap: 10px;
}

.col {
  display: grid;
  gap: 10px;
  min-width: 0;
}

@media (max-width: 900px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .account-screen {
    animation: none;
  }
}
</style>
