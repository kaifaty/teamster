// Where a lesson's change goes: the repository «Внедрить» starts its task in, the lesson's other repositories, and
// whether the place is clear enough to start without the form. Pure data for the lesson's card.

import type { Lesson, ResearchRepo } from "../../types";

/**
 * The repository the lesson form's «Репозиторий» starts with, as its path: a domain lesson's first named repository
 * the board knows, any other lesson's `teamster`; empty when there is none, and the human picks one.
 */
export function defaultRepo(lesson: Pick<Lesson, "scope" | "repos">, repos: readonly ResearchRepo[]): string {
  const named = (name: string) => repos.find((repo) => repo.name === name)?.path;
  if (lesson.scope === "domain") {
    for (const name of lesson.repos) {
      const path = named(name);
      if (path) return path;
    }
    return "";
  }
  return named("teamster") ?? "";
}

/** Where a lesson's change goes, for «Внедрить». */
export interface LessonPlace {
  /** The repository the task starts in, as its path from `repos`; empty when the board knows none. */
  repo: string;
  /** The launch repository's name; empty with `repo`. */
  name: string;
  /** The lesson's other repositories, by name, in their order. */
  others: string[];
  /** The place is clear: «Внедрить» starts the task there at once, without the form. */
  clear: boolean;
}

/** A place of `target` outside every git repository, `~/…`; any other place is a repository's name. */
const isHomePath = (place: string) => place.startsWith("~");

/** A lesson's `target` without blanks; an older report's `null` and an absent field are no target. */
const targetOf = (lesson: Pick<Lesson, "target">): string[] => (lesson.target ?? []).map((place) => place.trim()).filter(Boolean);

/** The repositories the board knows that `text` names as a word of its own, in the order they first appear. */
export function namedRepos(text: string | null | undefined, repos: readonly ResearchRepo[]): string[] {
  if (!text) return [];
  const found: { name: string; at: number }[] = [];
  for (const { name } of repos) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Case matters: «Agent V2» is no repository `agent`. Not a part of a longer name or of a path, a hidden directory
    // or a file's name with its extension.
    const match = new RegExp(`(?<![\\p{L}\\p{N}_.~/-])${escaped}(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}])`, "u").exec(text);
    if (match && !found.some((item) => item.name === name)) found.push({ name, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.name);
}

/** The lesson's fields its place reads; `proposal` is the one its card shows. */
export type PlacedLesson = Pick<Lesson, "scope" | "repos" | "proposal" | "target" | "outside">;

/**
 * Where «Внедрить» starts the lesson's task, and the lesson's other repositories: every one after the place's first,
 * known to the board or not.
 *
 * With a `target`, its repositories in their order, the first the board knows to start in; the place is clear with
 * exactly one repository the board knows, or with only `~/` paths, which start in the repository of the lesson's
 * scope, or `teamster`.
 *
 * Without one, the repositories the board knows that the proposal names, starting in the first; the place is clear
 * when it names exactly one and that one is the guess by scope — one of a domain lesson's repositories, any other
 * lesson's `teamster`. A proposal that names none keeps the guess by scope, clear only when the lesson changes files
 * outside git (`outside`) and the board knows the guess, as with a `target` of `~/` paths only.
 */
export function lessonPlace(lesson: PlacedLesson, repos: readonly ResearchRepo[]): LessonPlace {
  const pathOf = (name: string) => repos.find((repo) => repo.name === name)?.path ?? "";
  const place = (names: readonly string[], repo: string, clear: boolean): LessonPlace => {
    const name = repos.find((item) => item.path === repo)?.name ?? "";
    const first = names[0];
    return { repo, name, others: [...new Set(names)].filter((item) => item !== first && item !== name), clear: clear && !!repo };
  };
  const guess = defaultRepo(lesson, repos);
  const target = targetOf(lesson);
  if (target.length) {
    const names = [...new Set(target.filter((item) => !isHomePath(item)))];
    if (!names.length) return place([], guess || pathOf("teamster"), true);
    const known = names.find((name) => pathOf(name));
    return place(names, known ? pathOf(known) : "", names.length === 1);
  }
  const named = namedRepos(lesson.proposal, repos);
  if (named.length) {
    const only = named.length === 1 ? named[0]! : null;
    const scoped = !!only && (lesson.scope === "domain" ? lesson.repos.includes(only) : only === "teamster");
    return place(named, pathOf(named[0]!), scoped);
  }
  return place(lesson.scope === "domain" ? lesson.repos : [], guess, !!lesson.outside?.length);
}

/** «Где менять» on a lesson's card: its `target`, or the repositories its proposal names; empty when unknown. */
export function lessonWhere(lesson: Pick<Lesson, "proposal" | "target">, repos: readonly ResearchRepo[]): string[] {
  const target = targetOf(lesson);
  return target.length ? [...new Set(target)] : namedRepos(lesson.proposal, repos);
}
