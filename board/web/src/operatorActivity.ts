export interface OperatorTask {
  task_id: string;
  slug: string;
  title: string;
}

export interface OperatorActivity {
  available: boolean;
  chat?: boolean;
  current: OperatorTask | null;
  history: (OperatorTask & {
    event_id: string;
    turn: number;
    started_at: number;
    source: "mini" | "handoff";
    recommendation: string;
  })[];
}

export type OperatorTarget = ({ kind: "project"; id: string } | { kind: "run"; id: string; created: number })
  & { title: string };

export interface OperatorExchange {
  question: string;
  answer: string;
}

export interface ProjectOperatorMessage {
  id: string;
  at: number;
  question: string;
  reference: string | null;
  answer: string | null;
  status: "pending" | "answered" | "failed";
}

export type OperatorResolutionRule =
  | { card: string; run: string; rule: "verdict" }
  | { card: string; run: string; rule: "negative"; evidence: string; phrase: string }
  | { card: string; revoke: true }
  | { card: string; proposal: string; action: OperatorOption };

export type OperatorOption = "accept" | "cancel" | "continue" | "ask_executor" | "clarify";

export interface OperatorProposal {
  id: string;
  at: number;
  status: "pending" | "answered" | "failed";
  reason?: string;
  recommended?: OperatorOption;
  record_only?: boolean;
  options?: { action: OperatorOption; text: string }[];
}

export interface ProjectTaskOverview {
  status: "pending" | "answered" | "failed";
  change?: string;
  why?: string;
  expected?: string;
}

export interface OperatorResolution {
  writable: boolean;
  assignment: { run: string; status: string; evidence: string | null } | null;
  recommendations?: OperatorActivity["history"];
  commands?: {
    id: string;
    actor: string;
    run: string;
    slug: string;
    action: "start" | "say" | "stop";
    at: number;
    executor: string;
    account: string | null;
    model: string | null;
    text: string | null;
  }[];
  chat?: ProjectOperatorMessage[];
  proposals?: OperatorProposal[];
  overview?: ProjectTaskOverview | null;
  events: {
    seq: number;
    actor: "user" | "operator";
    kind: string;
    at: number;
    detail: {
      reason?: string; question?: string; pull_request?: string; failed_check?: string;
      archive?: string; sha?: string; files?: number; report?: string;
      operation?: string; id?: string; worktree?: string; phrase?: string; note?: string; run?: string; turn?: number;
      from?: import("./map/surface/types").SurfaceTask["status"];
      to?: import("./map/surface/types").SurfaceTask["status"];
      action?: OperatorOption; proposal?: string; verdict?: string;
      record_only?: boolean;
      evidence?: string | { slug: string; turn: number; report?: string } | null;
    };
  }[];
}

export const optionLabels: Record<OperatorOption, string> = {
  accept: "Принять и архивировать",
  cancel: "Отменить и архивировать",
  continue: "Продолжить работу",
  ask_executor: "Запросить данные у исполнителя",
  clarify: "Ответить на вопрос оператора",
};

export const resolutionLabels: Record<string, string> = {
  delegated: "Передал полномочия оператору",
  pending: "Полномочия переданы",
  waiting_run: "Ждёт завершения запуска",
  waiting_verdict: "Ждёт вердикта",
  waiting_evidence: "Ждёт связанный запуск",
  needs_decision: "Нужно решение",
  verdict_started: "Записывает вердикт",
  verdict_recorded: "Вердикт записан",
  archive_started: "Сохраняет архив",
  archived: "Запуск архивирован",
  cleanup_blocked: "Выполнение приостановлено",
  revoked: "Полномочия отозваны",
  choice: "Пользователь выбрал действие",
  status_changed: "Статус изменился",
  clarification_requested: "Ждёт ответа пользователя",
  waiting_followup: "Поручение передано исполнителю",
  followup_finished: "Исполнитель ответил",
  repair_conflict: "Оператор вернул исполнителю конфликт PR",
  conflict_detected: "PR конфликтует с базовой веткой",
  automatic_waiting: "Оператор проверил задачу и ждёт",
  automatic_question: "Вопрос оператора",
  automatic_merge: "Оператор подтвердил слияние PR",
};
export const automaticReasons: Record<string, string> = {
  dependency: "Жду завершения связанных задач.",
  dependency_cancelled: "Связанная задача отменена. Продолжить без неё?",
  queued_work: "Жду выполнения поручения из очереди.",
  executor_question: "Исполнителю нужно решение.",
  unfinished_turn: "Сессия прервалась без итогового отчёта. Возобновить незавершённую работу?",
  acceptance: "Результат готов. Принять его или нужна дополнительная проверка?",
  budget: "Бюджет хода исчерпан. Выделить время на оставшуюся работу или завершить задачу?",
  next_step: "Ход остановился. Продолжить оставшуюся работу или завершить задачу?",
  ambiguous_pr: "Не удалось однозначно привязать PR к запуску. Какой PR считать результатом?",
  pr_closed: "PR закрыт без слияния. Работа заменена или её нужно продолжить?",
  pr_open: "Жду слияния открытого PR.",
  pr_draft: "PR остаётся черновиком. Жду приёмки и слияния.",
  pr_conflict: "PR конфликтует с базовой веткой. Жду разрешения конфликта.",
  pr_unavailable: "Статус PR недоступен. Проверю его снова.",
  pr_other_base: "PR влит в промежуточную ветку. Жду подтверждения интеграции в main.",
  merge_identity: "Влитый PR не совпадает с веткой запуска. Какой результат принимать?",
  checkout_identity: "Локальный worktree отличается от влитой ветки. Как поступить с локальной работой?",
  checkout_dirty: "В worktree есть незакоммиченные изменения. Как их сохранить перед архивацией?",
  checkout_missing: "Worktree отсутствует. Жду подтверждения в локальной истории main, чтобы сохранить журнал.",
  checkout_unavailable: "Локальный репозиторий недоступен. Проверю его снова.",
};
