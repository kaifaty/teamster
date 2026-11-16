// The duty's choice for the console: the board's duty store (createDuty) for the map's source, the choice shown at once
// and held until the accounts confirm it, rolled back with teamster's text on a refusal, and teamster's warning kept.

import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import type { ActionResult } from "../../lib/actions";
import { createDuty, type DutyHost } from "../../store/duty";
import { choosingOff, confirms, dutyChoices, modeLine, shownDuty, type DutyChoice, type ShownDuty } from "./dutyPick";

/** How long a confirmed choice waits for the accounts to show it before the record speaks for itself again. */
export const HOLD_MS = 15_000;

export function useDutyPick(host: () => DutyHost) {
  const store = shallowRef(createDuty(host()));
  const pending = ref<ShownDuty | null>(null);
  /** Teamster's refusal of the last choice, or its warning on an accepted one. */
  const error = ref<string | null>(null);
  const warning = ref<string | null>(null);
  let hold: ReturnType<typeof setTimeout> | undefined;
  let sent = 0;

  function release() {
    clearTimeout(hold);
    pending.value = null;
  }
  watch(host, (next) => {
    release();
    error.value = warning.value = null;
    store.value = createDuty(next);
  });

  const duty = computed(() => store.value.duty.value);
  // Once the accounts show the choice, the record speaks for itself.
  watch(duty, (record) => {
    if (pending.value && confirms(record, pending.value)) release();
  });

  const shown = computed(() => shownDuty(duty.value, pending.value));
  const off = computed(() => choosingOff(duty.value));
  const choices = computed(() => dutyChoices(store.value.accounts.value, shown.value, !off.value));
  const line = computed(() => modeLine(duty.value, shown.value));

  async function apply(next: ShownDuty, run: () => Promise<ActionResult>) {
    if (off.value) return;
    const mine = ++sent;
    clearTimeout(hold);
    pending.value = next;
    error.value = warning.value = null;
    const result = await run();
    if (mine !== sent) return;
    if (!result.ok) {
      release();
      error.value = result.error;
      return;
    }
    warning.value = result.warning ?? null;
    if (confirms(duty.value, next)) release();
    else hold = setTimeout(release, HOLD_MS);
  }

  /** Pins `choice` as the duty: the automatic choosing stops. */
  function pick(choice: DutyChoice) {
    if (choice.disabled) return;
    void apply({ mode: "pinned", account: choice.account, family: choice.family }, () => store.value.choose(choice.account, choice.family));
  }

  /** «Выбирать автоматически»: on elects the duty; off leaves none until an account is chosen. */
  function setAuto(on: boolean) {
    const now = shown.value;
    if (on) void apply({ mode: "auto", account: now?.account ?? null, family: now?.family ?? null }, () => store.value.setAuto());
    else void apply({ mode: "off", account: null, family: null }, () => store.value.setOff());
  }

  onBeforeUnmount(() => clearTimeout(hold));

  return { duty, shown, pending, off, choices, line, error, warning, sending: computed(() => store.value.sending.value), pick, setAuto };
}

export type DutyPick = ReturnType<typeof useDutyPick>;
