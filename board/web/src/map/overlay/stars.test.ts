import { describe, expect, it } from "vitest";
import type { Star } from "../fleet";
import { starLabels, starTitle } from "./stars";

const star = (overrides: Partial<Star>): Star => ({ repo: "repo", live: 0, attention: 0, ready: 0, sleeping: 0, dots: [], ...overrides });

describe("star labels", () => {
  it("names the ships, then the alarms, the waiting and the sleeping ones", () => {
    expect(starTitle(star({ live: 5, attention: 1, ready: 2, sleeping: 3 }))).toBe("repo: задач 5 · тревог 1 · ждут 2 · спят 3");
    expect(starTitle(star({ live: 2, ready: 1 }))).toBe("repo: задач 2 · ждут 1");
  });

  it("calls a star without ships quiet", () => {
    expect(starTitle(star({}))).toBe("repo: тихо");
  });

  it("stands each label at its star with its emblem", () => {
    const [label] = starLabels([star({ live: 1 })], new Map([["repo", { x: 10.4, y: 20.6 }]]), (name) => `/art/${name}.png`);
    expect(label).toMatchObject({ style: { "--x": 10, "--y": 21 }, title: "repo: задач 1", emblem: "/art/repo.png" });
  });
});
