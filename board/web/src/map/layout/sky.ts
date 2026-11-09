// Which sky stands behind a star system.

import { hashName } from "./geometry";

/** Which of `count` skies system `repo` has; the same every time, or null when there are none. */
export function backdropOf(repo: string, count: number): number | null {
  return count > 0 ? hashName(repo) % count : null;
}

/** The skies to try for system `repo`, best first: its own, then its shared one. */
export function skyChoices(repo: string, own: string | undefined, backdrops: readonly string[]): string[] {
  const index = backdropOf(repo, backdrops.length);
  return [...(own ? [own] : []), ...(index === null ? [] : [backdrops[index]!])];
}
