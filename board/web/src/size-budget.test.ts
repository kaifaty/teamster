import { describe, expect, it } from "vitest";

// The board's own files stay small enough to read whole: a file that outgrows its budget is split, as the map was.
const BUDGET = { ts: 500, vue: 650 } as const;

const files = import.meta.glob<string>(["./**/*.ts", "./**/*.vue", "!./**/*.test.ts", "!./fixtures/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const lines = (text: string) => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

describe("size budget", () => {
  it("reads the board's files", () => {
    expect(Object.keys(files)).toContain("./map/MapView.vue");
    expect(Object.keys(files)).toContain("./main.ts");
    expect(Object.keys(files).some((name) => name.endsWith(".test.ts") || name.startsWith("./fixtures/"))).toBe(false);
  });

  it("keeps every .ts file within 500 lines and every .vue file within 650", () => {
    const over = Object.entries(files).flatMap(([name, text]) => {
      const limit = name.endsWith(".vue") ? BUDGET.vue : BUDGET.ts;
      const count = lines(text);
      return count > limit ? [`${name.slice(2)}: ${count} lines, the budget is ${limit}`] : [];
    });
    expect(over).toEqual([]);
  });
});
