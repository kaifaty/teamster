import { describe, expect, it } from "vitest";
import { answerText, lessonCommand, reflectCommand, reflectSlug, sayCommand, shellQuote, takesWords, taskCommands, transmission, verdictCommand } from "./commands";

describe("task commands", () => {
  it("offers every command for a task, and none for a desktop session", () => {
    expect(taskCommands({ slug: "fix-login", kind: "work" }).map((item) => item.command)).toEqual([
      "teamster status fix-login",
      "teamster wait fix-login",
      "teamster stop fix-login",
      "teamster review fix-login",
      "teamster clean fix-login",
    ]);
    expect(takesWords({ kind: "work" })).toBe(true);
    expect(taskCommands({ slug: "local_1", kind: "session" })).toEqual([]);
    expect(takesWords({ kind: "session" })).toBe(false);
  });

  it("gives a scout only status, wait, stop and clean", () => {
    expect(taskCommands({ slug: "scout-api", kind: "scout" }).map((item) => item.id)).toEqual(["status", "wait", "stop", "clean"]);
    expect(takesWords({ kind: "scout" })).toBe(false);
  });

  it("names an archived record by its task slug", () => {
    expect(taskCommands({ slug: "pr-template-20261105T101500Z", kind: "work" })[0]!.command).toBe("teamster status pr-template");
    expect(verdictCommand("pr-template-20261105T101500Z", "accepted")).toBe("teamster verdict pr-template accepted");
  });

  it("quotes the say text and the verdict note for a POSIX shell", () => {
    const text = "it's $HOME and `date`\nnext line";
    const quoted = "'it'\\''s $HOME and `date`\nnext line'";
    expect(shellQuote(text)).toBe(quoted);
    expect(sayCommand("fix-login", text)).toBe(`teamster say fix-login ${quoted}`);
    expect(verdictCommand("fix-login", "revised", `  ${text} `)).toBe(`teamster verdict fix-login revised --note ${quoted}`);
    expect(verdictCommand("fix-login", "dropped", "  ")).toBe("teamster verdict fix-login dropped");
  });

  it("names a reflection by UTC month, day, hour and minute", () => {
    expect(reflectSlug(new Date("2026-01-02T01:04:59+03:00"))).toBe("reflect-0101-220459");
    expect(reflectSlug(new Date("2026-11-09T05:07:00Z"))).toBe("reflect-1109-050700");
  });

  it("builds reflection selections and quotes their arguments", () => {
    expect(reflectCommand({ slug: "reflect-1109-0507" })).toBe("teamster reflect reflect-1109-0507");
    expect(reflectCommand({ slug: "study's name", tasks: ["fix-api", "a $(date)"], order: "Check analyst's $HOME" })).toBe(
      "teamster reflect 'study'\\''s name' --task fix-api --task 'a $(date)' 'Check analyst'\\''s $HOME'",
    );
    expect(reflectCommand({ slug: "reflect-1109-0507", since: "2026-11-01 12:00", repos: ["demo-game", "/tmp/demo's vault"], order: "  " })).toBe(
      "teamster reflect reflect-1109-0507 --since '2026-11-01 12:00' --repo demo-game --repo '/tmp/demo'\\''s vault'",
    );
    expect(() => reflectCommand({ slug: "study", tasks: ["fix-api"], since: "2026-11-01" })).toThrow();
    expect(() => reflectCommand({ slug: "study", tasks: ["fix-api"], repos: ["demo-game"] })).toThrow();
  });

  it("quotes a lesson entry and optional note", () => {
    expect(lessonCommand("batch-2026-11-09.md L1", "accepted")).toBe("teamster lesson 'batch-2026-11-09.md L1' accepted");
    expect(lessonCommand("study's report.md L2", "declined", "  Don't change $HOME  ")).toBe(
      "teamster lesson 'study'\\''s report.md L2' declined --note 'Don'\\''t change $HOME'",
    );
    expect(lessonCommand("report.md L1", "applied", "  ")).toBe("teamster lesson 'report.md L1' applied");
  });

  it("joins nonempty station commands in order", () => {
    expect(transmission(["", "teamster lesson 'report.md L1' accepted", "  ", "teamster say study 'Proceed'"])).toBe(
      "teamster lesson 'report.md L1' accepted && teamster say study 'Proceed'",
    );
    expect(transmission(["", " "])).toBe("");
  });

  it("numbers answered questions and shortens their text", () => {
    const long = "x".repeat(90);
    const questions = [
      { text: "  Which\nrepository?  ", options: ["demo-game", "demo-vault"] },
      { text: "Which approach?", options: [] },
      { text: long, options: [] },
      { text: "Continue?", options: [] },
    ];
    expect(answerText(questions, [" demo-game ", "  ", "Proceed\nwith study"])).toBe(
      `1. Which repository?: demo-game\n3. ${long.slice(0, 80)}: Proceed with study`,
    );
    expect(answerText(questions, [])).toBe("");
  });
});
