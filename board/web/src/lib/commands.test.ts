import { describe, expect, it } from "vitest";
import { sayCommand, shellQuote, takesWords, taskCommands, verdictCommand } from "./commands";

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
});
