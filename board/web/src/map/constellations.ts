// Constellations: repositories the galaxy draws together, from the board's GET /api/constellations.

import type { Constellations } from "../types";

/** One constellation as the map draws it: its name, the colour of its cloud and the repositories in it. */
export interface Constellation {
  name: string;
  color: string;
  repos: string[];
}

/** The clouds' colours, faint over the dark sky; a constellation keeps its colour while the list keeps its order. */
const COLORS = ["#8f7cf0", "#4fc3c8", "#e07aa8", "#d9a441", "#6fa8ff", "#7fcf7a"] as const;

/** A pattern from the file as a test: the name itself, where `*` stands for any run of characters. */
function matcher(pattern: string): (repo: string) => boolean {
  if (!pattern.includes("*")) return (repo) => repo === pattern;
  const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  const regex = new RegExp(`^${source}$`);
  return (repo) => regex.test(repo);
}

/**
 * The constellations of `repos`: each repository in the first constellation whose patterns match it, and only the
 * constellations with at least one repository of the galaxy, in the file's order, each with its repositories sorted.
 */
export function constellationsOf(data: Constellations | null, repos: readonly string[]): Constellation[] {
  const list = data?.constellations ?? [];
  const tests = list.map((item) => item.repos.map(matcher));
  const members = list.map(() => [] as string[]);
  for (const repo of repos) {
    const index = tests.findIndex((patterns) => patterns.some((test) => test(repo)));
    if (index >= 0) members[index]!.push(repo);
  }
  return list.flatMap((item, index) =>
    members[index]!.length ? [{ name: item.name, color: COLORS[index % COLORS.length]!, repos: [...members[index]!].sort() }] : [],
  );
}
