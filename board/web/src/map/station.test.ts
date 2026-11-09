import { describe, expect, it } from "vitest";
import type { Study, StudyMessage } from "../types";
import { fixtureSource } from "../fixtures/source";
import { research } from "./research";
import {
  analystOnDuty,
  filedLessons,
  signalTally,
  stationCounts,
  workingSince,
  docketPlacement,
  studyKey,
  turnKey,
  validSince,
  firstStudy,
  openQuestionsAt,
  orderCommand,
  reach,
  replyText,
  studyState,
  studyTitle,
  transmissionFor,
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

describe("transmission", () => {
  it("numbers the answers and adds the free text", () => {
    expect(replyText(asking.questions, ["Brief gap"], "  thanks ")).toBe("1. Brief gap or outside delay?: Brief gap\nthanks");
    expect(replyText(asking.questions, [""], "")).toBe("");
  });

  it("joins the decisions and the say into one command", () => {
    const open = study({ waiting: true, messages: [lead(100, null), asking] });
    const command = transmissionFor(
      [{ entry: "batch-2026-11-09.md V1", id: "V1", status: "declined", note: "one incident" }],
      open,
      "1. Brief gap",
    );
    expect(command).toBe(
      "teamster lesson 'batch-2026-11-09.md V1' declined --note 'one incident' && teamster say reflect-1109-041200 '1. Brief gap'",
    );
  });

  it("sends no say to a study that cannot take it", () => {
    const decision = { entry: "batch-2026-11-09.md V1", id: "V1", status: "accepted" as const, note: "" };
    expect(transmissionFor([decision], study({ alive: true }), "hello")).toBe("teamster lesson 'batch-2026-11-09.md V1' accepted");
    expect(transmissionFor([decision], study({ archived: true }), "hello")).toBe("teamster lesson 'batch-2026-11-09.md V1' accepted");
    expect(transmissionFor([], study(), "  ")).toBe("");
    expect(reach(null)).toBe("closed");
  });
});

describe("orderCommand", () => {
  const now = new Date(Date.UTC(2026, 10, 9, 4, 12));
  const draft = (patch: Partial<OrderDraft>): OrderDraft => ({ kind: "batch", tasks: "", since: "", repos: "", text: "", ...patch });

  it("builds a batch order with an optional focus", () => {
    expect(orderCommand(draft({}), now)).toEqual({ command: "teamster reflect reflect-1109-041200" });
    expect(orderCommand(draft({ text: "Focus on CI" }), now)).toEqual({ command: "teamster reflect reflect-1109-041200 'Focus on CI'" });
  });

  it("needs a task for a task order", () => {
    expect(orderCommand(draft({ kind: "tasks" }), now)).toEqual({ error: "Назови хотя бы одну задачу" });
    expect(orderCommand(draft({ kind: "tasks", tasks: "nft-send, wallet-fix" }), now)).toEqual({
      command: "teamster reflect reflect-1109-041200 --task nft-send --task wallet-fix",
    });
  });

  it("needs the question and a valid period for a question", () => {
    expect(orderCommand(draft({ kind: "question" }), now)).toEqual({ error: "Сформулируй вопрос" });
    expect("error" in orderCommand(draft({ kind: "question", text: "Why?", since: "last week" }), now)).toBe(true);
    expect("error" in orderCommand(draft({ kind: "question", text: "Why?", since: "2026-02-30" }), now)).toBe(true);
    // Without a period or projects it would be a batch.
    expect(orderCommand(draft({ kind: "question", text: "Why?" }), now)).toEqual({ error: "Укажи срок или проекты" });
    expect(orderCommand(draft({ kind: "question", text: "Why?", repos: "wallet" }), now)).toEqual({
      command: "teamster reflect reflect-1109-041200 --repo wallet 'Why?'",
    });
    expect(orderCommand(draft({ kind: "question", text: "Why?", since: "14d", repos: "wallet vault" }), now)).toEqual({
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

describe("transmission with an applied lesson", () => {
  it("marks it applied with the place as its note", () => {
    const command = transmissionFor([{ entry: "batch-2026-11-06.md U1", id: "U1", status: "applied", note: "AGENTS.md" }], null, "");
    expect(command).toBe("teamster lesson 'batch-2026-11-06.md U1' applied --note 'AGENTS.md'");
  });
});

describe("stationCounts", () => {
  it("counts the open questions of every waiting study and the material in the hold", async () => {
    const station = research(await fixtureSource().fetchResearch(), [], [])!;
    expect(stationCounts(station)).toEqual({
      questions: 1, waiting: 1, proposed: 3, accepted: 1, applied: 2, declined: 1, records: 7, signals: 4,
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
