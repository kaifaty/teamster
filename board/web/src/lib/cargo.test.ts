import { describe, expect, it } from "vitest";
import type { Cargo, CargoCi } from "../types";
import { cargoRows } from "./cargo";

const empty: Cargo = {
  check: null, claims: [], review: null, stop: null, ci: null, base: null, remaining: [], questions: [], decisions: { fixed: 0, rejected: 0 },
};
const ciText = (extra: Partial<CargoCi>) => {
  const ci: CargoCi = { outcome: null, passed: 0, failed: 0, total: 0, failing: [], seconds: null, rounds: 0, reason: null, ...extra };
  return cargoRows({ ...empty, ci }).find((row) => row.key === "ci")?.text;
};

describe("cargoRows", () => {
  it("names the CI outcome without repeating the row's label", () => {
    expect(ciText({ outcome: "pending" })).toBe("идёт");
    expect(ciText({ outcome: "skipped" })).toBe("пропущен");
    expect(ciText({ outcome: "timeout", passed: 3, total: 4, seconds: 1800 })).toBe("таймаут · 3 из 4 прошли · 30 мин");
    expect(ciText({ outcome: "none" })).toBe("нет проверок");
    expect(ciText({ outcome: "failed" })).toBe("упал");
    expect(ciText({ outcome: "mystery" })).toBe("mystery");
    expect(ciText({ outcome: "failed", passed: 4, failed: 2, total: 6, failing: ["build", "lint"], rounds: 1 })).toBe(
      "упало 2 из 6: build, lint · раундов починки: 1",
    );
    expect(ciText({ outcome: "passed", passed: 5, total: 5, seconds: 540 })).toBe("5 из 5 прошли · 9 мин");
  });
});
