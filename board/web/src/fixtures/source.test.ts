import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureSource } from "./source";

afterEach(() => vi.useRealTimers());

describe("fixture source", () => {
  it("takes a say to an ordinary task into its messages and acts on every task", async () => {
    vi.useFakeTimers();
    const source = fixtureSource();
    const removed: string[] = [];
    const stop = source.connect((message) => message.type === "task_removed" && removed.push(message.slug), () => {});
    const act = async (...args: Parameters<NonNullable<typeof source.act>>) => {
      const result = source.act!(...args);
      await vi.advanceTimersByTimeAsync(500);
      return result;
    };
    try {
      // Even while the replay has taken the ship off the board.
      await vi.advanceTimersByTimeAsync(16_000);
      expect(removed).toContain("accounts-json-schema");
      expect(await act("say", { slug: "accounts-json-schema", text: "Доработай перед приёмкой" })).toMatchObject({ ok: true });
      await vi.advanceTimersByTimeAsync(10_000);
      const detail = await source.fetchDetail("accounts-json-schema");
      expect(detail?.messages?.at(-1)).toMatchObject({ source: "lead", text: "Доработай перед приёмкой" });
      expect((await source.fetchDetail("board-web-frontend"))?.actions).toEqual({ enabled: true, reason: null });
      expect(await act("say", { slug: "reflect-review-patterns", text: "demo-wallet" })).toEqual({ ok: true, output: "said to reflect-review-patterns" });
    } finally {
      stop();
    }
  });
});
