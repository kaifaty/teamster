// Duty selection uses the board's existing accounts stream; no extra polling or component is needed.
import { computed, ref, type Ref } from "vue";
import type { DutyBody, DutyFamily } from "../dutyTypes";
import { parseAccounts, parseDuty } from "../lib/accounts";
import { requestDuty, type ActionResult } from "../lib/actions";
import type { BoardSource } from "../lib/source";
import type { Accounts } from "../types";

export interface DutyHost {
  source: BoardSource;
  state: Readonly<Ref<{ accounts: Accounts | null }>>;
}

/** All selections are reflected by the next accounts message, including changes from another board tab. */
export function createDuty(host: DutyHost) {
  const duty = computed(() => parseDuty(host.state.value.accounts?.data));
  const accounts = computed(() => (parseAccounts(host.state.value.accounts?.data, Date.now() / 1000).items ?? [])
    .flatMap((item) => item.kind === "row" ? [item.row] : []));
  const sending = ref(false);
  let pending = 0;

  async function send(body: DutyBody): Promise<ActionResult> {
    pending += 1;
    sending.value = true;
    try {
      return await requestDuty(body, host.source.act);
    } finally {
      sending.value = --pending > 0;
    }
  }

  return {
    duty,
    mode: computed(() => duty.value?.mode ?? null),
    choosable: computed(() => duty.value?.choosable ?? false),
    accounts,
    sending,
    choose: (account: string, family: DutyFamily) => send({ account, family }),
    setAuto: () => send({ mode: "auto" }),
    setOff: () => send({ mode: "off" }),
  };
}
