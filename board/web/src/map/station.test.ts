import { describe, expect, it } from "vitest";
import type { Implementation, Lesson, Study, StudyMessage } from "../types";
import { fixtureSource } from "../fixtures/source";
import { research } from "./research";
import {
  analystOnDuty,
  canImplement,
  defaultRepo,
  filedLessons,
  implementBody,
  implementationLine,
  signalTally,
  stationCounts,
  workingSince,
  discussOrder,
  docketPlacement,
  nextStep,
  studyKey,
  turnKey,
  validSince,
  firstStudy,
  openQuestionsAt,
  orderAction,
  reach,
  replyText,
  studyState,
  studyTitle,
  type OrderDraft,
} from "./station";

const lead = (at: number, text: string | null): StudyMessage => ({ at, from: "lead", text, status: null, questions: [], lessons: [], file: null });
const analyst = (at: number, patch: Partial<StudyMessage> = {}): StudyMessage => ({
  at,
  from: "analyst",
  text: "report",
  status: "done",
  questions: [],
  lessons: [],
  file: "batch-2026-11-09.md",
  ...patch,
});

const study = (patch: Partial<Study> = {}): Study => ({
  slug: "reflect-1109-041200",
  archived: false,
  mode: "batch",
  alive: false,
  outcome: "completed",
  error: null,
  executor: "claude",
  account: null,
  created: 100,
  updated_at: 200,
  records: 3,
  file: null,
  waiting: false,
  messages: [lead(100, null)],
  ...patch,
});

const asking = analyst(150, {
  status: "needs_decision",
  questions: [{ text: "Brief gap or outside delay?", options: ["Brief gap", "Outside delay"] }],
  lessons: [{ id: "V1", cue: "network error ends the turn", entry: "batch-2026-11-09.md V1", scope: "invariant", lesson: "Resume the session", proposal: null }],
});

describe("studyState", () => {
  it("puts work first, then a waiting question, then a failed turn", () => {
    expect(studyState(study({ alive: true, waiting: true }))).toBe("working");
    expect(studyState(study({ waiting: true }))).toBe("waiting");
    expect(studyState(study({ outcome: "failed" }))).toBe("failed");
    expect(studyState(study({ archived: true }))).toBe("closed");
    expect(studyState(study())).toBe("idle");
  });
});

describe("studyTitle", () => {
  it("takes the order's first line, cut to 90 characters", () => {
    expect(studyTitle(study({ messages: [lead(1, "Why does CI need two rounds?\nLook at wallet")] }))).toBe("Why does CI need two rounds?");
    expect(studyTitle(study({ messages: [lead(1, "x".repeat(120))] }))).toHaveLength(90);
  });

  it("names a study without an order by its mode", () => {
    expect(studyTitle(study())).toBe("Плановый разбор");
    expect(studyTitle(study({ mode: "study" }))).toBe("Разбор по приказу");
  });
});

describe("firstStudy", () => {
  it("prefers a waiting study, then a running one, then the newest", () => {
    const newest = study({ slug: "a" });
    const running = study({ slug: "b", alive: true });
    const waiting = study({ slug: "c", waiting: true });
    expect(firstStudy([newest, running, waiting])?.slug).toBe("c");
    expect(firstStudy([newest, running])?.slug).toBe("b");
    expect(firstStudy([newest])?.slug).toBe("a");
    expect(firstStudy([])).toBeNull();
  });
});

describe("docketPlacement", () => {
  it("shows each docket at the last message that carries it", () => {
    const later = analyst(180, { lessons: [...asking.lessons, { id: "V2", cue: "other", entry: "batch-2026-11-09.md V2", scope: null, lesson: null, proposal: null }] });
    const placement = docketPlacement([lead(100, null), asking, lead(160, "answer"), later]);
    expect(placement.get("V1")).toBe(3);
    expect(placement.get("V2")).toBe(3);
  });
});

describe("openQuestionsAt", () => {
  it("is the last analyst message of a waiting study", () => {
    expect(openQuestionsAt(study({ waiting: true, messages: [lead(100, null), asking] }))).toBe(1);
    expect(openQuestionsAt(study({ messages: [lead(100, null), asking] }))).toBe(-1);
    expect(openQuestionsAt(study({ waiting: true, messages: [lead(100, null), analyst(150)] }))).toBe(-1);
  });
});

describe("replyText", () => {
  it("numbers the answers and adds the free text", () => {
    expect(replyText(asking.questions, ["Brief gap"], "  thanks ")).toBe("1. Brief gap or outside delay?: Brief gap\nthanks");
    expect(replyText(asking.questions, [""], "")).toBe("");
    expect(reach(null)).toBe("closed");
  });
});

describe("orderAction", () => {
  const now = new Date(Date.UTC(2026, 10, 9, 4, 12));
  const draft = (patch: Partial<OrderDraft>): OrderDraft => ({ kind: "batch", tasks: "", since: "", repos: "", text: "", ...patch });

  it("builds a batch order with an optional focus", () => {
    expect(orderAction(draft({}), now)).toEqual({ body: {}, command: "teamster reflect reflect-1109-041200" });
    expect(orderAction(draft({ text: " Focus on CI " }), now)).toEqual({
      body: { order: "Focus on CI" },
      command: "teamster reflect reflect-1109-041200 'Focus on CI'",
    });
  });

  it("needs a task for a task order", () => {
    expect(orderAction(draft({ kind: "tasks" }), now)).toEqual({ error: "Назови хотя бы одну задачу" });
    expect(orderAction(draft({ kind: "tasks", tasks: "nft-send, wallet-fix", since: "30d", text: "CI" }), now)).toEqual({
      body: { tasks: ["nft-send", "wallet-fix"], order: "CI" },
      command: "teamster reflect reflect-1109-041200 --task nft-send --task wallet-fix 'CI'",
    });
  });

  it("needs the question and a valid period for a question", () => {
    expect(orderAction(draft({ kind: "question" }), now)).toEqual({ error: "Сформулируй вопрос" });
    expect("error" in orderAction(draft({ kind: "question", text: "Why?", since: "last week" }), now)).toBe(true);
    expect("error" in orderAction(draft({ kind: "question", text: "Why?", since: "2026-02-30" }), now)).toBe(true);
    // Without a period or projects it would be a batch.
    expect(orderAction(draft({ kind: "question", text: "Why?" }), now)).toEqual({ error: "Укажи срок или проекты" });
    expect(orderAction(draft({ kind: "question", text: "Why?", repos: "wallet" }), now)).toEqual({
      body: { repos: ["wallet"], order: "Why?" },
      command: "teamster reflect reflect-1109-041200 --repo wallet 'Why?'",
    });
    expect(orderAction(draft({ kind: "question", text: "Why?", since: "14d", repos: "wallet vault" }), now)).toEqual({
      body: { since: "14d", repos: ["wallet", "vault"], order: "Why?" },
      command: "teamster reflect reflect-1109-041200 --since 14d --repo wallet --repo vault 'Why?'",
    });
  });
});

describe("keys", () => {
  it("tells apart a reused slug and the turns of one study", () => {
    expect(studyKey(study({ created: 1 }))).not.toBe(studyKey(study({ created: 2 })));
    const first = study({ waiting: true, messages: [lead(100, null), asking] });
    const second = study({ waiting: true, messages: [lead(100, null), asking, lead(160, "answer"), { ...asking, at: 190 }] });
    expect(turnKey(first)).not.toBe(turnKey(second));
  });

  it("accepts only real dates and day counts", () => {
    expect(validSince("2026-11-01")).toBe(true);
    expect(validSince("14d")).toBe(true);
    expect(validSince("2026-02-30")).toBe(false);
    expect(validSince("yesterday")).toBe(false);
  });
});

describe("stationCounts", () => {
  it("counts the open questions of every waiting study and the material in the hold", async () => {
    const station = research(await fixtureSource().fetchResearch(), [], [])!;
    expect(stationCounts(station)).toEqual({
      questions: 1, waiting: 1, proposed: 3, accepted: 6, applied: 2, declined: 1, records: 7, signals: 4,
    });
  });
});

describe("filedLessons", () => {
  it("keeps the newest docket of each entry with the study it stands in", () => {
    const old = study({ slug: "old", messages: [lead(100, null), asking] });
    const revised = analyst(300, { lessons: [{ ...asking.lessons[0]!, lesson: "Resume the same session" }] });
    const fresh = study({ slug: "fresh", created: 250, messages: [lead(250, null), asking, revised] });
    const filed = filedLessons([fresh, old]);
    expect(filed.get("batch-2026-11-09.md V1")).toMatchObject({ id: "V1", lesson: "Resume the same session", study: { slug: "fresh" } });
  });
});

describe("signalTally", () => {
  it("counts records per signal, a repeated signal once per record", () => {
    expect(signalTally([
      { slug: "a", repo: "x", stamp: "1", signals: ["blocked", "fix_rounds", "blocked"] },
      { slug: "b", repo: "x", stamp: "2", signals: ["fix_rounds"] },
    ])).toEqual([{ signal: "fix_rounds", count: 2 }, { signal: "blocked", count: 1 }]);
  });
});

describe("analystOnDuty", () => {
  it("works, then waits, then reports a failure only in the newest study", () => {
    const working = study({ slug: "w", alive: true });
    const waiting = study({ slug: "q", waiting: true, messages: [lead(100, null), asking] });
    const failed = study({ slug: "f", outcome: "failed" });
    expect(analystOnDuty([waiting, working]).state).toBe("working");
    expect(analystOnDuty([failed, waiting])).toMatchObject({ state: "waiting", study: { slug: "q" } });
    expect(analystOnDuty([failed, study()]).state).toBe("failed");
    expect(analystOnDuty([study(), failed]).state).toBe("free");
    expect(analystOnDuty([])).toEqual({ state: "free", study: null });
  });
});

describe("workingSince", () => {
  it("is the live study's last turn, and nothing when no study works", async () => {
    const station = research(await fixtureSource().fetchResearch(), [], [])!;
    expect(workingSince(station)).toBeNull();
    const live = study({ alive: true, messages: [lead(100, null), analyst(180)] });
    expect(workingSince({ ...station, studies: [live], running: true })).toBe(180);
  });
});

const task = (patch: Partial<Implementation> = {}): Implementation => ({
  slug: "lesson-u1", archived: false, alive: false, repo: "teamster", result_status: null, pr: null, questions: [], summary: null, created: 100, updated_at: 200,
  ...patch,
});

describe("a lesson's implementation", () => {
  const repos = [
    { name: "teamster", path: "/dev/teamster" },
    { name: "demo-game", path: "/dev/demo-game" },
  ];

  it("sends the entry and the repository's path, and the note only when there is one", () => {
    expect(implementBody(" batch.md U1 ", "/dev/teamster", "  ")).toEqual({ entry: "batch.md U1", repo: "/dev/teamster" });
    expect(implementBody("batch.md U1", "/dev/teamster", " only the docs ")).toEqual({ entry: "batch.md U1", repo: "/dev/teamster", note: "only the docs" });
  });

  it("starts «Где внедрять» at a domain lesson's own repository, at teamster for a shared one, or empty", () => {
    expect(defaultRepo({ scope: "domain", repos: ["gone", "demo-game"] }, repos)).toBe("/dev/demo-game");
    expect(defaultRepo({ scope: "invariant", repos: [] }, repos)).toBe("/dev/teamster");
    expect(defaultRepo({ scope: "domain", repos: ["gone"] }, repos)).toBe("");
    expect(defaultRepo({ scope: "other", repos: [] }, [repos[1]!])).toBe("");
  });

  it("offers «Внедрить» only without an implementation or after a closed one", () => {
    expect(canImplement({})).toBe(true);
    expect(canImplement({ implementation: null })).toBe(true);
    expect(canImplement({ implementation: task({ result_status: "done" }) })).toBe(false);
    expect(canImplement({ implementation: task({ archived: true }) })).toBe(true);
  });

  it("tells how the implementation goes by the first state that fits", () => {
    expect(implementationLine(null)).toBeNull();
    expect(implementationLine(null, { slug: "lesson-u1", repo: "teamster" })).toMatchObject({ kind: "started", text: "Внедряется: lesson-u1 · teamster" });
    expect(implementationLine(task({ alive: true, result_status: "needs_decision", repo: "demo-game" }))).toMatchObject({ kind: "working", text: "Агент работает · demo-game", answer: false });
    expect(implementationLine(task({ result_status: "needs_decision", questions: ["Where?"] }))).toEqual({
      kind: "decision", text: "Агенту нужно решение", questions: ["Where?"], answer: true,
    });
    expect(implementationLine(task({ result_status: "done", pr: "https://github.com/o/r/pull/41", archived: true }))).toEqual({
      kind: "pr", pr: "https://github.com/o/r/pull/41", label: "PR #41", before: "PR готов: ", after: ". Проверь и смёржи, затем отметь «Внедрено».", answer: false,
    });
    expect(implementationLine(task({ result_status: "done" }))).toMatchObject({ kind: "stopped", text: "Агент остановился (done)" });
    expect(implementationLine(task({ result_status: "blocked", summary: "No dump" }))).toEqual({
      kind: "stopped", text: "Агент остановился (blocked)", summary: "No dump", answer: true,
    });
    expect(implementationLine(task({ archived: true, result_status: "partial", pr: "https://github.com/o/r/pull/7" }))).toEqual({
      kind: "closed", text: "Задача закрыта", pr: "https://github.com/o/r/pull/7", label: "PR #7", answer: false,
    });
    expect(implementationLine(task({ archived: true, result_status: "needs_decision" }))).toMatchObject({ kind: "closed", pr: null });
    // The research carries the task the card started: its own state wins.
    expect(implementationLine(task({ alive: true }), { slug: "lesson-u1", repo: "teamster" })).toMatchObject({ kind: "working" });
  });
});

describe("nextStep", () => {
  const clock = { state: "counting" as const, when: "завтра в 09:00" };
  const lesson = (status: Lesson["status"], implementation: Implementation | null = null, id: string = status): Lesson => ({
    date: "2026-11-09", entry: `batch-2026-11-09.md ${id}`, scope: "invariant", scope_text: "invariant", repos: [], cue: "cue", status, status_text: status, implementation,
  });

  it("asks for an answer, then decisions, then shows the work, then the lessons to apply, then the plan", async () => {
    const base = research(await fixtureSource().fetchResearch(), [], [])!;
    const waiting = study({ slug: "q", waiting: true, messages: [lead(100, "Why do checks repeat?"), asking] });
    const working = study({ slug: "w", alive: true, messages: [lead(100, "Compare CI"), analyst(400)] });
    const station = { ...base, studies: [working, waiting], running: true, proposed: [lesson("proposed")], accepted: [lesson("accepted")] };

    expect(nextStep(station, 1000, clock)).toMatchObject({ text: "Аналитик ждёт ответа: Why do checks repeat?", action: { kind: "reply", label: "Ответить", study: { slug: "q" } } });
    const deciding = { ...station, studies: [working] };
    expect(nextStep(deciding, 1000, clock)).toMatchObject({ text: "Уроков ждут решения: 1", action: { kind: "review", label: "Разобрать" } });
    const busy = { ...deciding, proposed: [] };
    expect(nextStep(busy, 1000, clock)).toMatchObject({ text: "Аналитик работает: Compare CI · 10 мин", action: null });
    const quiet = { ...busy, studies: [], running: false };
    expect(nextStep(quiet, 1000, clock)).toMatchObject({ text: "Приняты и ждут внедрения: 1", action: { kind: "accepted", label: "Показать" } });
    expect(nextStep({ ...quiet, accepted: [] }, 1000, clock)).toEqual({ text: "Всё разобрано. Плановый разбор завтра в 09:00", action: null, tone: "" });
  });

  it("puts the implementations' agents in their places: a decision after the analyst, the work and the PR after the analyst's work", async () => {
    const base = research(await fixtureSource().fetchResearch(), [], [])!;
    const waiting = study({ slug: "q", waiting: true, messages: [lead(100, "Why do checks repeat?"), asking] });
    const working = study({ slug: "w", alive: true, messages: [lead(100, "Compare CI"), analyst(400)] });
    const asks = lesson("accepted", task({ result_status: "needs_decision" }), "U2");
    const ready = lesson("accepted", task({ result_status: "done", pr: "https://github.com/o/r/pull/9" }), "U3");
    const live = lesson("accepted", task({ alive: true }), "U4");
    const station = { ...base, studies: [working, waiting], running: true, proposed: [lesson("proposed")], accepted: [ready, live, asks, lesson("accepted")] };

    expect(nextStep(station, 1000, clock).text).toBe("Аналитик ждёт ответа: Why do checks repeat?");
    const deciding = { ...station, studies: [working] };
    expect(nextStep(deciding, 1000, clock)).toMatchObject({ text: "Агенту нужно решение: урок U2", action: { kind: "agent", label: "Ответить", lesson: asks } });
    const proposing = { ...deciding, accepted: [ready, live, lesson("accepted")] };
    expect(nextStep(proposing, 1000, clock).text).toBe("Уроков ждут решения: 1");
    const busy = { ...proposing, proposed: [] };
    expect(nextStep(busy, 1000, clock).text).toBe("Аналитик работает: Compare CI · 10 мин");
    const agents = { ...busy, studies: [], running: false };
    expect(nextStep(agents, 1000, clock)).toEqual({ text: "Агент внедряет урок U4", action: { kind: "watch", label: "Посмотреть", lesson: live }, tone: "live" });
    const many = { ...agents, accepted: [...agents.accepted, lesson("accepted", task({ alive: true }), "U5")] };
    expect(nextStep(many, 1000, clock).text).toBe("Агенты внедряют уроки: 2");
    const done = { ...agents, accepted: [ready, lesson("accepted")] };
    expect(nextStep(done, 1000, clock)).toMatchObject({ text: "PR готов по уроку U3", action: { kind: "pr", label: "Показать", lesson: ready } });
    expect(nextStep({ ...done, accepted: [lesson("accepted")] }, 1000, clock).text).toBe("Приняты и ждут внедрения: 1");
  });
});

describe("discussOrder", () => {
  it("names the lesson, its report and the question after an empty line", () => {
    const order = "Обсуждаем урок batch-2026-11-05.md T1 («Review a partial result»). Прочитай его раздел в файле batch-2026-11-05.md и записи из его доказательств. Ответь на вопрос ниже; если урок стоит уточнить или переписать — предложи новую редакцию.";
    expect(discussOrder({ entry: "batch-2026-11-05.md T1", cue: "cue", title: "Review a partial result" }, "  ")).toBe(order);
    expect(discussOrder({ entry: "batch-2026-11-05.md T1", cue: "cue", title: "Review a partial result" }, " Why now? ")).toBe(`${order}\n\nWhy now?`);
    expect(discussOrder({ entry: "batch-2026-11-05.md T1", cue: "a cue" }, "")).toContain("(«a cue»)");
  });
});
